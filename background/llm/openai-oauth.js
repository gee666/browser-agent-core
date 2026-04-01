import { LLMProvider } from './base.js';
import { LLMError } from './utils.js';
import { generatePKCE, generateState, storeTokens, getValidTokens, clearTokens, exchangeCode, decodeJwt, OAuthError } from './oauth.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const PROVIDER_KEY = 'openai-codex';

/**
 * Build the OpenAI Codex authorization URL.
 * Returns { url, verifier, state }.
 */
export async function buildOpenAIAuthUrl() {
  const { verifier, challenge } = await generatePKCE();
  const state = generateState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'pi');
  return { url: url.toString(), verifier, state };
}

export const OPENAI_REDIRECT_URI = REDIRECT_URI;

/**
 * Exchange authorization code for OpenAI tokens.
 * Returns { access, refresh, expires, accountId }.
 */
export async function exchangeOpenAICode(code, verifier) {
  const data = await exchangeCode(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  }, true /* form-urlencoded */);

  if (!data.access_token || !data.refresh_token) {
    throw new OAuthError(`OpenAI token exchange missing fields: ${JSON.stringify(data)}`);
  }

  const payload = decodeJwt(data.access_token);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  if (!accountId) throw new OAuthError('Failed to extract accountId from OpenAI token');

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

/**
 * Refresh an OpenAI access token.
 */
export async function refreshOpenAIToken(refreshToken) {
  const data = await exchangeCode(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }, true /* form-urlencoded */);

  if (!data.access_token || !data.refresh_token) {
    throw new OAuthError(`OpenAI token refresh missing fields`);
  }
  const payload = decodeJwt(data.access_token);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId: accountId || 'unknown',
  };
}

// The Codex OAuth token is a ChatGPT subscription token.
// It does NOT work with api.openai.com — it uses chatgpt.com/backend-api instead.
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

/**
 * Build the Codex SSE request body.
 * Uses the OpenAI Responses API format (input array, not messages).
 */
function buildCodexBody(model, system, messages, screenshot) {
  const input = [];
  const lastUserIdx = [...messages].map(m => m.role).lastIndexOf('user');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      // content is always a plain string from our history
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      input.push({ role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
    } else {
      // user message — content is always a plain string (screenshots are NOT stored in history)
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const parts = [{ type: 'input_text', text }];

      // Attach current screenshot only to the last user message
      if (i === lastUserIdx && screenshot) {
        // Strip the data-URL prefix — Codex wants the raw base64 PNG
        const _mimeMatch = screenshot.match(/^data:(image\/[^;]+);base64,/);
        const _mimeType = _mimeMatch ? _mimeMatch[1] : 'image/png';
        const raw = screenshot.replace(/^data:image\/[^;]+;base64,/, '');
        parts.push({ type: 'input_image', detail: 'auto', image_url: `data:${_mimeType};base64,${raw}` });
      }

      input.push({ role: 'user', content: parts });
    }
  }

  return {
    model,
    store: false,
    stream: true,
    instructions: system,
    input,
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
  };
}

/**
 * Parse a Codex SSE streaming response and return the full text.
 * Accumulates response.output_text.delta events.
 */
async function parseCodexSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by double newline
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());

        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'response.output_text.delta') {
              fullText += event.delta || '';
            } else if (event.type === 'error') {
              throw new LLMError(`Codex error: ${event.message || JSON.stringify(event)}`);
            } else if (event.type === 'response.failed') {
              throw new LLMError(`Codex response failed: ${event.response?.error?.message || 'unknown'}`);
            }
          } catch (e) {
            if (e instanceof LLMError) throw e;
            // ignore JSON parse errors on individual chunks
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }

  if (!fullText) throw new LLMError('Codex returned empty response');
  return fullText;
}

/**
 * OpenAI Codex OAuth LLM provider.
 * Uses chatgpt.com/backend-api (NOT api.openai.com) — the Codex OAuth token
 * is a ChatGPT subscription token and requires the chatgpt-account-id header.
 */
export class OpenAICodexOAuthProvider extends LLMProvider {
  constructor({ model = 'gpt-5.1' } = {}) {
    super();
    this._model = model;
  }

  async complete({ system, messages, screenshot }) {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt) => refreshOpenAIToken(rt));
    await storeTokens(PROVIDER_KEY, tokens);

    const { access, accountId } = tokens;
    if (!accountId) throw new OAuthError('Missing accountId in stored OpenAI token. Please re-login.');

    const body = buildCodexBody(this._model, system, messages, screenshot);

    const response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access}`,
        'chatgpt-account-id': accountId,
        'originator': 'pi',
        'OpenAI-Beta': 'responses=experimental',
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LLMError(`OpenAI OAuth request failed (${response.status}): ${text}`);
    }

    return parseCodexSSE(response);
  }

  static async isLoggedIn() {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt) => refreshOpenAIToken(rt)).catch(() => null);
    return tokens !== null;
  }

  static async getStoredTokens() {
    const { getTokens: gt } = await import('./oauth.js');
    return gt(PROVIDER_KEY);
  }

  static async logout() {
    await clearTokens(PROVIDER_KEY);
  }
}
