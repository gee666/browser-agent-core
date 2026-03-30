/**
 * Chrome extension OAuth utilities.
 * Replaces the Node.js http.createServer approach with a tab-based interception.
 * The service worker registers a persistent webNavigation listener at startup;
 * state is kept in chrome.storage.session to survive SW restarts.
 */

export class OAuthError extends Error {
  constructor(message) { super(message); this.name = 'OAuthError'; }
}

/**
 * PKCE generation using Web Crypto API (works in SW and browsers)
 */
export async function generatePKCE() {
  function base64urlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64urlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

/**
 * Generate a random state string for CSRF protection.
 */
export function generateState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store OAuth pending state before opening the auth tab.
 * Call this from the service worker message handler before chrome.tabs.create.
 * The webNavigation listener (registered at SW top-level) will read this state.
 */
export async function setPendingOAuth(provider, { verifier, state, tabId = null }) {
  await chrome.storage.session.set({
    pendingOAuth: { provider, verifier, state, tabId, startedAt: Date.now() }
  });
}

export async function setPendingOAuthTabId(tabId) {
  const data = await chrome.storage.session.get('pendingOAuth');
  if (data.pendingOAuth) {
    data.pendingOAuth.tabId = tabId;
    await chrome.storage.session.set({ pendingOAuth: data.pendingOAuth });
  }
}

export async function getPendingOAuth() {
  const data = await chrome.storage.session.get('pendingOAuth');
  return data.pendingOAuth || null;
}

export async function clearPendingOAuth() {
  await chrome.storage.session.remove('pendingOAuth');
}

/**
 * Store OAuth tokens for a provider.
 * providerKey: 'openai-codex' | 'anthropic' | 'gemini-cli'
 */
export async function storeTokens(providerKey, tokens) {
  const key = `oauth.${providerKey}`;
  await chrome.storage.local.set({ [key]: tokens });
}

export async function getTokens(providerKey) {
  const key = `oauth.${providerKey}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

export async function clearTokens(providerKey) {
  const key = `oauth.${providerKey}`;
  await chrome.storage.local.remove(key);
}

/**
 * Get tokens, refreshing if expired (or expiring within 5 minutes).
 * refreshFn: async (refreshToken, extra) => { access, refresh, expires, ...extra }
 * extra: any additional fields stored with tokens (e.g. projectId for Gemini)
 */
export async function getValidTokens(providerKey, refreshFn) {
  const tokens = await getTokens(providerKey);
  if (!tokens) throw new OAuthError(`Not logged in to ${providerKey}. Please login via Settings.`);
  
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < tokens.expires - fiveMinutes) {
    return tokens; // still valid
  }
  
  // Refresh
  const refreshed = await refreshFn(tokens.refresh, tokens);
  await storeTokens(providerKey, refreshed);
  return refreshed;
}

/**
 * Parse a redirect URL to extract code and state params.
 */
export function parseRedirectUrl(redirectUrl) {
  try {
    const url = new URL(redirectUrl);
    return {
      code: url.searchParams.get('code') || null,
      state: url.searchParams.get('state') || null,
      error: url.searchParams.get('error') || null,
    };
  } catch {
    return { code: null, state: null, error: 'invalid url' };
  }
}

/**
 * Exchange an authorization code for tokens via POST.
 * Supports both JSON and form-urlencoded request bodies.
 */
export async function exchangeCode(tokenUrl, body, asForm = false) {
  const headers = { 'Content-Type': asForm ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json' };
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: asForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new OAuthError(`Token exchange failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

/**
 * Decode a JWT payload (no signature verification).
 */
export function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}
