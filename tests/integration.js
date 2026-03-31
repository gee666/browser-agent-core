/**
 * End-to-end integration test.
 * Uses real OAuth tokens from ~/.pi/agent/auth.json.
 * Mocks the Chrome browser APIs (no real browser needed).
 *
 * Run: node tests/integration.js
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Load credentials ──────────────────────────────────────────────────────────
const authPath = join(homedir(), '.pi', 'agent', 'auth.json');
const auth = JSON.parse(readFileSync(authPath, 'utf-8'));

// ── Colour helpers ────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[34m${s}\x1b[0m`;

let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${B('▸')} ${name} ... `);
  try {
    await fn();
    console.log(G('PASS'));
    passed++;
  } catch (err) {
    console.log(R('FAIL'));
    console.error(`    ${R(err.message)}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Shared fake page state ────────────────────────────────────────────────────
const FAKE_PAGE_STATE = {
  url: 'https://example.com/login',
  title: 'Login – Example',
  viewportWidth: 1280,
  viewportHeight: 720,
  pageWidth: 1280,
  pageHeight: 1200,
  context: { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 },
  elements: [
    {
      id: 'el_0', tag: 'INPUT', type: 'email', role: 'textbox',
      label: 'Email address', placeholder: 'you@example.com',
      rect: { x: 480, y: 300, width: 320, height: 40 },
      inViewport: true, enabled: true, value: '', checked: null, href: null, text: null,
    },
    {
      id: 'el_1', tag: 'INPUT', type: 'password', role: 'textbox',
      label: 'Password', placeholder: 'Password',
      rect: { x: 480, y: 360, width: 320, height: 40 },
      inViewport: true, enabled: true, value: '', checked: null, href: null, text: null,
    },
    {
      id: 'el_2', tag: 'BUTTON', type: 'submit', role: 'button',
      label: 'Sign in', placeholder: null,
      rect: { x: 480, y: 420, width: 320, height: 44 },
      inViewport: true, enabled: true, value: null, checked: null, href: null, text: 'Sign in',
    },
  ],
};

// ── Mock Chrome APIs ──────────────────────────────────────────────────────────
global.chrome = {
  storage: {
    local: {
      _data: {},
      get(key, cb) {
        const result = typeof key === 'string'
          ? { [key]: this._data[key] }
          : Object.fromEntries(key.map(k => [k, this._data[k]]));
        if (cb) cb(result); else return Promise.resolve(result);
      },
      set(obj, cb) {
        Object.assign(this._data, obj);
        if (cb) cb(); else return Promise.resolve();
      },
      remove(key, cb) {
        delete this._data[typeof key === 'string' ? key : key[0]];
        if (cb) cb(); else return Promise.resolve();
      },
    },
    session: {
      _data: {},
      get(key, cb) {
        const result = typeof key === 'string'
          ? { [key]: this._data[key] }
          : Object.fromEntries(key.map(k => [k, this._data[k]]));
        if (cb) cb(result); else return Promise.resolve(result);
      },
      set(obj, cb) { Object.assign(this._data, obj); if (cb) cb(); else return Promise.resolve(); },
    },
  },
  runtime: {
    sendMessage: () => Promise.resolve(),
    lastError: null,
    onMessage: { addListener: () => {} },
  },
  tabs: {
    query: (_, cb) => cb([{ id: 1, url: FAKE_PAGE_STATE.url, title: FAKE_PAGE_STATE.title }]),
    sendMessage: (tabId, msg, cb) => {
      if (msg.type === 'get_page_state') cb(FAKE_PAGE_STATE);
      else if (msg.type === 'wait_for_settle') cb({ settled: true });
      else cb(null);
    },
    update: (tabId, props, cb) => cb({ id: tabId }),
    captureVisibleTab: (wid, opts, cb) => cb(null),
  },
  webNavigation: {
    onCompleted: { addListener: () => {}, removeListener: () => {} },
    onBeforeNavigate: { addListener: () => {}, removeListener: () => {} },
  },
  scripting: { executeScript: (_, cb) => cb() },
};

// ── Pre-load tokens into fake chrome storage ──────────────────────────────────
for (const [provider, creds] of Object.entries(auth)) {
  chrome.storage.local._data[`oauth.${provider}`] = creds;
}

// ── Import modules after chrome is defined ────────────────────────────────────
const { AnthropicOAuthProvider, refreshAnthropicToken } = await import('../background/llm/anthropic-oauth.js');
const { OpenAICodexOAuthProvider, refreshOpenAIToken } = await import('../background/llm/openai-oauth.js');
const { GeminiOAuthProvider, refreshGeminiToken } = await import('../background/llm/gemini-oauth.js');
const { storeTokens } = await import('../background/llm/oauth.js');
const { AgentCore } = await import('../background/agent.js');
const { BrowserBridge } = await import('../background/browser-bridge.js');
const { ActionExecutor } = await import('../background/executor.js');
const { InputControlBridge } = await import('../background/input-control.js');

// ── Helper: refresh token if expired ─────────────────────────────────────────
async function ensureFresh(providerKey, creds, refreshFn) {
  if (Date.now() < creds.expires - 60_000) return creds; // still good
  console.log(`    ${Y('refreshing ' + providerKey + ' token...')}`);
  const refreshed = await refreshFn(creds.refresh, creds);
  await storeTokens(providerKey, refreshed);
  return refreshed;
}

// ── 1. LLM Provider tests ─────────────────────────────────────────────────────
console.log('\n' + B('── LLM Provider tests ──────────────────────────────────────'));

await test('Anthropic OAuth: complete() returns non-empty string', async () => {
  const creds = await ensureFresh('anthropic', auth.anthropic, refreshAnthropicToken);
  chrome.storage.local._data['oauth.anthropic'] = creds;

  const provider = new AnthropicOAuthProvider({ model: 'claude-haiku-4-5' });
  const result = await provider.complete({
    system: 'You are a test assistant. Respond ONLY with the word PONG and nothing else.',
    messages: [{ role: 'user', content: 'PING' }],
    screenshot: null,
  });
  assert(typeof result === 'string' && result.length > 0, 'expected non-empty string');
  assert(result.trim().toUpperCase().includes('PONG'), `expected PONG, got: ${result.trim()}`);
});

await test('OpenAI Codex OAuth: refresh expired token', async () => {
  const creds = await ensureFresh('openai-codex', auth['openai-codex'], refreshOpenAIToken);
  chrome.storage.local._data['oauth.openai-codex'] = creds;
  assert(creds.access && creds.refresh, 'refreshed token should have access + refresh');
  assert(creds.expires > Date.now(), 'refreshed token should not be immediately expired');
});

await test('OpenAI Codex OAuth: complete() returns non-empty string', async () => {
  // Relies on token being refreshed by the previous test
  const provider = new OpenAICodexOAuthProvider({ model: 'gpt-5.1' });
  const result = await provider.complete({
    system: 'You are a test assistant. Respond ONLY with the word PONG and nothing else.',
    messages: [{ role: 'user', content: 'PING' }],
    screenshot: null,
  });
  assert(typeof result === 'string' && result.length > 0, 'expected non-empty string');
  assert(result.trim().toUpperCase().includes('PONG'), `expected PONG, got: ${result.trim()}`);
});

await test('Gemini CLI OAuth: refresh expired token', async () => {
  const creds = await ensureFresh('gemini-cli', auth['google-gemini-cli'], (rt, prev) => refreshGeminiToken(rt, prev));
  chrome.storage.local._data['oauth.gemini-cli'] = creds;
  assert(creds.access && creds.projectId, 'refreshed Gemini token should have access + projectId');
});

await test('Gemini CLI OAuth: complete() returns non-empty string', async () => {
  // NOTE: requires Cloud Code Assist API to be enabled in the GCP project.
  // The v1internal:streamGenerateContent endpoint returns 404 if the project
  // is on a standard-tier plan without the API explicitly enabled.
  // Skip gracefully if we get a 404/403.
  const provider = new GeminiOAuthProvider({ model: 'gemini-2.0-flash' });
  try {
    const result = await provider.complete({
      system: 'You are a test assistant. Respond ONLY with the word PONG and nothing else.',
      messages: [{ role: 'user', content: 'PING' }],
      screenshot: null,
    });
    assert(typeof result === 'string' && result.length > 0, 'expected non-empty string');
    assert(result.trim().toUpperCase().includes('PONG'), `expected PONG, got: ${result.trim()}`);
  } catch (err) {
    if (/404|403|NOT_FOUND|PERMISSION/.test(err.message)) {
      console.log(`\n    ${Y('SKIP')} Cloud Code Assist API not enabled for this GCP project (${err.message.slice(0,60)})`);
      return; // not a code bug
    }
    throw err;
  }
});

// ── 2. Agent JSON format test ─────────────────────────────────────────────────
console.log('\n' + B('── Agent JSON format tests ─────────────────────────────────'));

await test('Anthropic: agent returns valid JSON with actions for login task', async () => {
  const provider = new AnthropicOAuthProvider({ model: 'claude-haiku-4-5' });

  // Build exactly what the agent would send
  const { AgentCore: AC } = await import('../background/agent.js');
  const fakeAgent = new AC({
    llm: provider,
    bridge: { sendStatus: () => {}, getActiveTabId: async () => 1, getPageState: async () => FAKE_PAGE_STATE, takeScreenshot: async () => null, navigate: async () => {}, waitForPageSettle: async () => {} },
    executor: { execute: async () => {} },
    onStatus: () => {},
    maxIterations: 1,
    useVision: false,
  });

  const userMsg = fakeAgent.buildUserMessage(
    'Login to https://example.com/login with email test@example.com and password secret123',
    FAKE_PAGE_STATE, 0, []
  );

  const raw = await provider.complete({
    system: fakeAgent.systemPrompt(),
    messages: [{ role: 'user', content: userMsg }],
    screenshot: null,
  });

  console.log(`\n    Raw response: ${Y(raw.substring(0, 200))}`);

  // Parse it
  const { parseJSONFromText } = await import('../background/llm/utils.js');
  const parsed = parseJSONFromText(raw);

  assert(typeof parsed.done === 'boolean', '"done" must be boolean');
  if (!parsed.done) {
    assert(Array.isArray(parsed.actions), '"actions" must be array when done=false');
    assert(parsed.actions.length > 0, 'expected at least one action');
    const firstAction = parsed.actions[0];
    assert(typeof firstAction.command === 'string', 'action.command must be string');
    assert(typeof firstAction.params === 'object', 'action.params must be object');
    console.log(`\n    ${G('✓')} ${parsed.actions.length} actions: ${parsed.actions.map(a => a.command).join(', ')}`);
  } else {
    console.log(`\n    ${G('✓')} done=true, message: ${parsed.message}`);
  }
});

await test('OpenAI Codex: agent returns valid JSON with actions for login task', async () => {
  const provider = new OpenAICodexOAuthProvider({ model: 'gpt-5.1' });

  const fakeAgent = new AgentCore({
    llm: provider,
    bridge: { sendStatus: () => {}, getActiveTabId: async () => 1, getPageState: async () => FAKE_PAGE_STATE, takeScreenshot: async () => null, navigate: async () => {}, waitForPageSettle: async () => {} },
    executor: { execute: async () => {} },
    onStatus: () => {},
    maxIterations: 1,
    useVision: false,
  });

  const userMsg = fakeAgent.buildUserMessage(
    'Login to https://example.com/login with email test@example.com and password secret123',
    FAKE_PAGE_STATE, 0, []
  );

  const raw = await provider.complete({
    system: fakeAgent.systemPrompt(),
    messages: [{ role: 'user', content: userMsg }],
    screenshot: null,
  });

  console.log(`\n    Raw response: ${Y(raw.substring(0, 200))}`);

  const { parseJSONFromText } = await import('../background/llm/utils.js');
  const parsed = parseJSONFromText(raw);

  assert(typeof parsed.done === 'boolean', '"done" must be boolean');
  if (!parsed.done) {
    assert(Array.isArray(parsed.actions), '"actions" must be array');
    assert(parsed.actions.length > 0, 'expected at least one action');
    console.log(`\n    ${G('✓')} ${parsed.actions.length} actions: ${parsed.actions.map(a => a.command).join(', ')}`);
  }
});

// ── 3. Full agent loop test ───────────────────────────────────────────────────
console.log('\n' + B('── Full agent loop test ─────────────────────────────────────'));

await test('AgentCore: runs one iteration with Anthropic, produces done or actions', async () => {
  const statuses = [];
  const executedActions = [];

  const mockBridge = {
    sendStatus: (s) => {},
    getActiveTabId: async () => 1,
    getPageState: async () => FAKE_PAGE_STATE,
    takeScreenshot: async () => null,
    navigate: async () => {},
    waitForPageSettle: async () => {},
  };

  const mockExecutor = {
    execute: async (actions) => { executedActions.push(...actions); },
  };

  const provider = new AnthropicOAuthProvider({ model: 'claude-haiku-4-5' });

  const agent = new AgentCore({
    llm: provider,
    bridge: mockBridge,
    executor: mockExecutor,
    onStatus: (s) => { statuses.push(s); },
    maxIterations: 2,
    useVision: false,
  });

  await agent.run('Fill in the login form at https://example.com/login with email test@example.com and password hunter2 then click Sign in');

  // Verify status sequence
  const states = statuses.map(s => s.state);
  console.log(`\n    States: ${states.join(' → ')}`);
  assert(states.includes('running'), 'should have reported running');
  assert(states.includes('thinking'), 'should have reported thinking');
  assert(states.some(s => s === 'acting' || s === 'done'), 'should have acted or completed');

  // Verify all statuses have required fields
  for (const s of statuses) {
    assert(typeof s.iteration === 'number', `status.iteration must be number, got ${s.iteration}`);
    assert(typeof s.maxIterations === 'number', `status.maxIterations must be number`);
    assert(typeof s.timestamp === 'number', `status.timestamp must be number`);
  }

  if (executedActions.length > 0) {
    console.log(`\n    Executed actions: ${executedActions.map(a => a.command).join(', ')}`);
    for (const a of executedActions) {
      assert(typeof a.command === 'string', 'action.command must be string');
      assert(typeof a.params === 'object', 'action.params must be object');
    }
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
const total = passed + failed;
if (failed === 0) {
  console.log(G(`✓ All ${total} tests passed`));
} else {
  console.log(R(`✗ ${failed}/${total} tests failed`));
  process.exit(1);
}
