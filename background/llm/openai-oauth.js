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

/**
 * OpenAI Codex OAuth LLM provider.
 * Uses stored OAuth tokens instead of an API key.
 * Tokens are stored under 'openai-codex' in chrome.storage.local.
 */
export class OpenAICodexOAuthProvider extends LLMProvider {
  constructor({ model = 'gpt-4o', maxTokens = 4096, temperature = 0.2 } = {}) {
    super();
    this._model = model;
    this._maxTokens = maxTokens;
    this._temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt) => refreshOpenAIToken(rt));
    await storeTokens(PROVIDER_KEY, tokens); // save refreshed token

    // Build messages in OpenAI format
    const builtMessages = [{ role: 'system', content: system }, ...messages];

    // Add screenshot to last user message if provided
    const supportsVision = /gpt-4o?|vision/i.test(this._model);
    if (screenshot && supportsVision) {
      const lastUserIdx = builtMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx !== -1) {
        const lastMsg = builtMessages[lastUserIdx];
        const textContent = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
        builtMessages[lastUserIdx] = {
          role: 'user',
          content: [
            { type: 'text', text: textContent },
            { type: 'image_url', image_url: { url: screenshot } },
          ],
        };
      }
    }

    const body = {
      model: this._model,
      messages: builtMessages,
      max_tokens: this._maxTokens,
      temperature: this._temperature,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) throw new LLMError(`OpenAI OAuth request failed (${response.status}): ${text}`);
    const json = JSON.parse(text);
    return json.choices[0].message.content;
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
