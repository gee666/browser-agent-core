import { LLMProvider } from './base.js';
import { LLMError } from './utils.js';
import { generatePKCE, storeTokens, getValidTokens, clearTokens, getCredentials, storeCredentials, exchangeCode, OAuthError } from './oauth.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const PROVIDER_KEY = 'gemini-cli';
const LEGACY_GEMINI_OAUTH_CONFIG_KEY = 'oauth.gemini-cli.config';

export const GEMINI_REDIRECT_URI = REDIRECT_URI;

async function getGeminiClientCredentials() {
  try {
    const credentials = await getCredentials(PROVIDER_KEY);
    if (credentials?.clientId && credentials?.clientSecret) {
      return credentials;
    }

    if (globalThis.chrome?.storage?.local) {
      const data = await chrome.storage.local.get(LEGACY_GEMINI_OAUTH_CONFIG_KEY);
      const legacyConfig = data?.[LEGACY_GEMINI_OAUTH_CONFIG_KEY];
      if (legacyConfig?.clientId && legacyConfig?.clientSecret) {
        await storeCredentials(PROVIDER_KEY, legacyConfig);
        await chrome.storage.local.remove(LEGACY_GEMINI_OAUTH_CONFIG_KEY);
        return legacyConfig;
      }
    }
  } catch {
    // Ignore storage lookup failures and fall through to the explicit error below.
  }

  throw new OAuthError(
    'Missing Gemini OAuth client credentials in chrome.storage.local at oauth.gemini-cli.credentials.'
  );
}

/**
 * Build the Google authorization URL.
 * Returns { url, verifier, state }.
 */
export async function buildGeminiAuthUrl() {
  const { clientId } = await getGeminiClientCredentials();
  const { verifier, challenge } = await generatePKCE();
  const state = verifier; // same pattern as Gemini CLI
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

/**
 * Exchange Google authorization code for tokens.
 * Returns { access, refresh, expires, projectId, email }.
 */
export async function exchangeGeminiCode(code, verifier) {
  const { clientId, clientSecret } = await getGeminiClientCredentials();
  const data = await exchangeCode(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }, true /* form-urlencoded */);

  if (!data.access_token) throw new OAuthError('Gemini token exchange failed: no access_token');
  if (!data.refresh_token) throw new OAuthError('No refresh_token received. Try again.');

  const accessToken = data.access_token;
  const email = await getUserEmail(accessToken);
  const projectId = await discoverProject(accessToken);

  return {
    access: accessToken,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId,
    email,
  };
}

/**
 * Refresh a Google Cloud access token.
 */
export async function refreshGeminiToken(refreshToken, prevTokens) {
  const { clientId, clientSecret } = await getGeminiClientCredentials();
  const projectId = prevTokens?.projectId;
  const data = await exchangeCode(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, true /* form-urlencoded */);

  if (!data.access_token) throw new OAuthError('Gemini token refresh failed');

  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId,
    email: prevTokens?.email,
  };
}

async function getUserEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      return data.email || null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Discover or provision a Google Cloud project via Cloud Code Assist API.
 * Simplified for browser extension: no process.env support, just API-based discovery.
 */
async function discoverProject(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': JSON.stringify({ ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }),
  };

  // Try loadCodeAssist
  const loadRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
  });

  if (loadRes.ok) {
    const data = await loadRes.json();
    if (data.currentTier && data.cloudaicompanionProject) {
      return data.cloudaicompanionProject;
    }
  }

  // Need onboarding - use free-tier
  const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tierId: 'free-tier',
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    }),
  });

  if (!onboardRes.ok) {
    throw new OAuthError(`Failed to provision Gemini Cloud project: ${onboardRes.status}`);
  }

  let lroData = await onboardRes.json();

  // Poll if LRO is not done
  if (!lroData.done && lroData.name) {
    lroData = await pollOperation(lroData.name, headers);
  }

  const projectId = lroData.response?.cloudaicompanionProject?.id;
  if (!projectId) throw new OAuthError('Could not obtain Google Cloud project ID. Try logging out and in again.');
  return projectId;
}

async function pollOperation(operationName, headers, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, { method: 'GET', headers });
    if (!res.ok) throw new OAuthError(`Operation poll failed: ${res.status}`);
    const data = await res.json();
    if (data.done) return data;
  }
  throw new OAuthError('Project provisioning timed out');
}

/**
 * Gemini CLI OAuth LLM provider.
 * Uses Google Cloud Code Assist API (free via OAuth, model: gemini-2.0-flash etc.)
 */
export class GeminiOAuthProvider extends LLMProvider {
  constructor({ model = 'gemini-2.0-flash', maxTokens = 4096, temperature = 0.2 } = {}) {
    super();
    this._model = model;
    this._maxTokens = maxTokens;
    this._temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt, prev) => refreshGeminiToken(rt, prev));
    await storeTokens(PROVIDER_KEY, tokens);

    const { access, projectId } = tokens;
    if (!projectId) throw new OAuthError('Missing Google Cloud projectId. Please re-login.');

    // Convert messages to Gemini format
    const contents = messages.map((msg, idx) => {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      // Add screenshot to last user message
      const isLastUser = msg.role === 'user' && idx === messages.map(m => m.role).lastIndexOf('user');
      if (isLastUser && screenshot) {
        const _mimeMatch = screenshot.match(/^data:(image\/[^;]+);base64,/);
        const _mimeType = _mimeMatch ? _mimeMatch[1] : 'image/png';
        const rawBase64 = screenshot.replace(/^data:image\/[^;]+;base64,/, '');
        return {
          role,
          parts: [
            { text },
            { inlineData: { mimeType: _mimeType, data: rawBase64 } },
          ],
        };
      }

      return { role, parts: [{ text }] };
    });

    const requestBody = {
      project: projectId,
      model: this._model,
      request: {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          maxOutputTokens: this._maxTokens,
          temperature: this._temperature,
          responseMimeType: 'application/json',
        },
      },
      userAgent: 'pi-coding-agent',
      requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };

    const headers = {
      'Authorization': `Bearer ${access}`,
      'Content-Type': 'application/json',
      'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Client-Metadata': JSON.stringify({ ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }),
    };

    const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMError(`Gemini OAuth request failed (${response.status}): ${errorText}`);
    }

    // Parse SSE response and concatenate all text parts
    return await parseGeminiSSEResponse(response);
  }

  static async isLoggedIn() {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt, prev) => refreshGeminiToken(rt, prev)).catch(() => null);
    return tokens !== null;
  }

  static async logout() {
    await clearTokens(PROVIDER_KEY);
  }
}

/**
 * Parse Gemini SSE streaming response and concatenate all text parts.
 */
async function parseGeminiSSEResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(jsonStr);
        // Extract text from candidates
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            if (typeof part.text === 'string' && !part.thought) {
              fullText += part.text;
            }
          }
        }
      } catch {
        // ignore parse errors on individual chunks
      }
    }
  }

  if (!fullText) throw new LLMError('Gemini returned empty response');
  return fullText;
}
