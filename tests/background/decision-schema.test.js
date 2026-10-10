/** @jest-environment node */
import { jest } from '@jest/globals';
import { OpenAIProvider } from '../../background/llm/openai.js';
import { OpenAICodexOAuthProvider } from '../../background/llm/openai-oauth.js';
import { BrowserBridge } from '../../background/browser-bridge.js';
import { AgentCore } from '../../background/agent.js';
import { fitsOpenAISchemaEnumLimit } from '../../background/llm/utils.js';

const schema = { type: 'object', properties: { action: { type: 'string', enum: ['CLICK'] } }, required: ['action'], additionalProperties: false };
const params = { system: 'Classify.', messages: [{ role: 'user', content: 'context' }], responseSchema: schema };
const originalFetch = global.fetch;
beforeEach(() => { global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }); chrome.runtime.lastError = undefined; });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test('supported OpenAI model receives strict schema only when requested', async () => {
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-4o' });
  await provider.complete(params);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'browser_decision', strict: true, schema } });
  await provider.complete({ ...params, responseSchema: undefined });
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).response_format).toEqual({ type: 'json_object' });
});

test.each([{ model: 'gpt-3.5-turbo' }, { model: 'gpt-4o', baseUrl: 'http://compatible.test/v1' }])('unsupported/compatible endpoint retains JSON mode %#', async config => {
  const provider = new OpenAIProvider({ apiKey: 'fixture', ...config });
  await provider.complete(params);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).response_format).toEqual({ type: 'json_object' });
});

test('staged schemas also enable vision for recent GPT models', async () => {
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-6-luna' });
  await provider.complete({ ...params, screenshot: 'data:image/png;base64,YQ==' });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).messages.at(-1).content.at(-1).type).toBe('image_url');
});

test('OAuth Responses requests receive optional schema while normal request format is preserved', async () => {
  chrome.storage.local.get.mockResolvedValue({ 'oauth.openai-codex': { access: 'fixture', accountId: 'fixture', expires: Date.now() + 1000000 } });
  chrome.storage.local.set.mockResolvedValue();
  global.fetch.mockImplementation(async () => new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n', { status: 200 }));
  const provider = new OpenAICodexOAuthProvider({ model: 'gpt-6-luna' });
  await expect(provider.complete(params)).resolves.toBe('{}');
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).text.format).toEqual({ type: 'json_schema', name: 'browser_decision', strict: true, schema });
  await provider.complete({ ...params, responseSchema: undefined });
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).text).toEqual({ verbosity: 'medium' });
});

function targetSchema(count) {
  const agent = new AgentCore({ bridge: {}, executor: {}, llm: {}, decisionMode: 'jev' });
  const questions = agent._stagedDecision.questions({ elements: Array.from({ length: count }, (_, index) => ({ index, tag: 'div', text: 'Custom', attrs: {}, inViewport: true })) }, 'text');
  return { type: 'object', properties: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'string', enum: Object.keys(q.criteria) }])), required: Object.keys(questions), additionalProperties: false };
}

test.each([197, 253])('OpenAI %i-target schema uses JSON-object mode, retaining all offered choices', async count => {
  const responseSchema = targetSchema(count);
  expect(fitsOpenAISchemaEnumLimit(responseSchema)).toBe(false);
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-6-luna' });
  await provider.complete({ ...params, system: 'Return JSON for the exact offered choices.', responseSchema });
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect(responseSchema.properties.target_CLICK.enum).toHaveLength(count + 1);
});

test.each([197, 253])('OAuth Responses %i-target schema uses documented text.format JSON-object mode', async count => {
  chrome.storage.local.get.mockResolvedValue({ 'oauth.openai-codex': { access: 'fixture', accountId: 'fixture', expires: Date.now() + 1000000 } });
  chrome.storage.local.set.mockResolvedValue();
  global.fetch.mockImplementation(async () => new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n', { status: 200 }));
  const provider = new OpenAICodexOAuthProvider({ model: 'gpt-6-luna' });
  await provider.complete({ ...params, system: 'Return JSON for the exact offered choices.', responseSchema: targetSchema(count) });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).text.format).toEqual({ type: 'json_object' });
});

test('strict enum count includes duplicates across properties, allowing exactly 1000', () => {
  const repeated = { enum: Array(500).fill('choice') };
  expect(fitsOpenAISchemaEnumLimit({ properties: { a: repeated, b: repeated } })).toBe(true);
  expect(fitsOpenAISchemaEnumLimit({ properties: { a: repeated, b: repeated, c: { enum: ['extra'] } } })).toBe(false);
  expect(fitsOpenAISchemaEnumLimit(targetSchema(196))).toBe(true);
});

test('bridge inspection and resolution use only content messages', async () => {
  chrome.tabs.sendMessage.mockImplementation((tab, message, cb) => cb({ ok: true }));
  chrome.tabs.sendMessage.mockClear(); chrome.scripting.executeScript.mockClear();
  const bridge = new BrowserBridge();
  await bridge.inspectDOM(5, { selector: '#widget', limit: 3 });
  await bridge.resolveDOMTarget(5, { selector: '#widget', expectedUrl: 'https://example.test/' });
  expect(chrome.tabs.sendMessage.mock.calls.map(([tab, msg]) => [tab, msg])).toEqual([
    [5, { type: 'inspect_dom', selector: '#widget', limit: 3 }],
    [5, { type: 'resolve_dom_target', selector: '#widget', expectedUrl: 'https://example.test/' }],
  ]);
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
});

test('bridge investigation timeout is bounded', async () => {
  jest.useFakeTimers(); chrome.tabs.sendMessage.mockImplementation(() => {});
  const result = new BrowserBridge().inspectDOM(1);
  const rejection = expect(result).rejects.toThrow('DOM investigation timed out');
  await jest.advanceTimersByTimeAsync(5000); await rejection;
});

test('bridge investigation errors do not echo browser transport payloads', async () => {
  chrome.tabs.sendMessage.mockImplementation((tab, message, cb) => { chrome.runtime.lastError = { message: 'private-secret' }; cb(); chrome.runtime.lastError = undefined; });
  await expect(new BrowserBridge().inspectDOM(1)).rejects.toThrow('DOM investigation unavailable');
});
