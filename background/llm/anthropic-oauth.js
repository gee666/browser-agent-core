import { LLMProvider } from './base.js';
import { LLMError } from './utils.js';
import { generatePKCE, storeTokens, getValidTokens, clearTokens, exchangeCode, OAuthError } from './oauth.js';

const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'http://localhost:53692/callback';
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const PROVIDER_KEY = 'anthropic';

export const ANTHROPIC_REDIRECT_URI = REDIRECT_URI;

/**
 * Build the Anthropic authorization URL.
 * Returns { url, verifier, state }.
 * Note: Anthropic uses `state = verifier` (not a separate random state).
 */
export async function buildAnthropicAuthUrl() {
  const { verifier, challenge } = await generatePKCE();
  // Anthropic uses the verifier itself as the state (matching pi-mono behaviour)
  const state = verifier;
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

/**
 * Exchange authorization code for Anthropic tokens.
 * Returns { access, refresh, expires }.
 */
export async function exchangeAnthropicCode(code, state, verifier) {
  const data = await exchangeCode(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }, false /* JSON */);

  if (!data.access_token || !data.refresh_token) {
    throw new OAuthError(`Anthropic token exchange missing fields: ${JSON.stringify(data)}`);
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Refresh an Anthropic access token.
 */
export async function refreshAnthropicToken(refreshToken) {
  const data = await exchangeCode(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }, false /* JSON */);

  if (!data.access_token || !data.refresh_token) {
    throw new OAuthError('Anthropic token refresh missing fields');
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Anthropic OAuth LLM provider.
 * Uses stored OAuth tokens with `Authorization: Bearer` instead of `x-api-key`.
 */
export class AnthropicOAuthProvider extends LLMProvider {
  constructor({ model = 'claude-opus-4-5', maxTokens = 4096, temperature = 0.2 } = {}) {
    super();
    this._model = model;
    this._maxTokens = maxTokens;
    this._temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt) => refreshAnthropicToken(rt));
    await storeTokens(PROVIDER_KEY, tokens);

    // Build Anthropic messages format (exclude system — goes as top-level param)
    const anthropicMessages = messages.map(msg => {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      if (typeof msg.content === 'string') {
        return { role, content: msg.content };
      }
      return { role, content: msg.content };
    });

    // Add screenshot to last user message
    if (screenshot) {
      const lastUserIdx = anthropicMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx !== -1) {
        const rawBase64 = screenshot.replace(/^data:image\/png;base64,/, '');
        const textContent = typeof anthropicMessages[lastUserIdx].content === 'string'
          ? anthropicMessages[lastUserIdx].content
          : JSON.stringify(anthropicMessages[lastUserIdx].content);
        anthropicMessages[lastUserIdx] = {
          role: 'user',
          content: [
            { type: 'text', text: textContent },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: rawBase64 } },
          ],
        };
      }
    }

    const body = {
      model: this._model,
      max_tokens: this._maxTokens,
      temperature: this._temperature,
      system,
      messages: [...anthropicMessages, { role: 'assistant', content: '{' }],
    };

    // Anthropic OAuth access tokens (sk-ant-oat01-...) are used as API keys,
    // not as Bearer tokens. The Authorization header is not supported.
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': tokens.access,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) throw new LLMError(`Anthropic OAuth request failed (${response.status}): ${text}`);
    const json = JSON.parse(text);
    return '{' + json.content[0].text;
  }

  static async isLoggedIn() {
    const tokens = await getValidTokens(PROVIDER_KEY, (rt) => refreshAnthropicToken(rt)).catch(() => null);
    return tokens !== null;
  }

  static async logout() {
    await clearTokens(PROVIDER_KEY);
  }
}
