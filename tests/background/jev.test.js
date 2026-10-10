/** @jest-environment node */
import { jest } from '@jest/globals';
import { createServer } from 'node:http';
import { normalizeJevConfig, classifyJev, testJevConnection, JevError } from '../../background/jev.js';
import { BrowserAgent, AgentCore } from '../../background/index.js';

const originalFetch = global.fetch;
const questions = { action: { type: 'choice', instructions: 'Choose.', criteria: { CLICK: 'Click', BLOCKED: 'Blocked' } } };
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test.each(['http://localhost:8765', 'http://localhost:8765/', 'http://localhost:8765/v1', 'http://localhost:8765/v1/', 'http://localhost:8765/v1/systemone'])('normalizes %s', baseUrl => {
  expect(normalizeJevConfig({ baseUrl }).endpoint).toBe('http://localhost:8765/v1/systemone');
});

test.each([
  { baseUrl: 'javascript:secret' }, { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'https://host/?key=secret' },
  { headers: { Authorization: 'secret' } }, { headers: { 'Content-Type': 'bad' } }, { headers: { 'x-test': 'a\r\nsecret' } },
  { headers: { 'x-test': 7 } }, { requestParams: { state: 'secret' } }, { requestParams: { questions: {} } }, { requestParams: { images: [] } },
  { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: '100' }, { apiKey: 'secret\n' }, { fallbackEnabled: 'true' },
])('rejects unsafe config without echoing values %#', config => {
  expect(() => normalizeJevConfig(config)).toThrow();
  try { normalizeJevConfig(config); } catch (e) { expect(e.message).not.toContain('secret'); }
});

test('standalone core defaults to server without overriding legacy headers', () => {
  expect(normalizeJevConfig({}).cacheMode).toBe('server');
  const headers = { 'X-AutoJev-Prefix-Cache': 'true' };
  expect(normalizeJevConfig({ headers }).headers).toEqual(headers);
});

test.each(['server', 'none', 'options', 'context'])('validates and posts cache mode %s without changing the body or credentials', async cacheMode => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: 'CLICK' } }) });
  const headers = { 'x-autojev-prefix-cache': 'true', 'X-Client': 'fixture' };
  const config = { cacheMode, headers, apiKey: 'private-key', model: 'custom-model', requestParams: { temperature: 0 } };
  expect(normalizeJevConfig(config).cacheMode).toBe(cacheMode);
  await classifyJev(config, { state: 'shared-state', questions });
  const request = global.fetch.mock.calls[0][1];
  expect(request.headers).toEqual({
    ...headers, 'Content-Type': 'application/json', Authorization: 'Bearer private-key',
    ...(cacheMode === 'server' ? {} : { 'X-AutoJev-Cache-Mode': cacheMode }),
  });
  expect(JSON.parse(request.body)).toEqual({ model: 'custom-model', temperature: 0, state: 'shared-state', questions });
  expect(config.headers).toEqual(headers);
});

test.each(['', 'CONTEXT', ' context ', 'invalid-secret', null, false, 1, {}, []])('rejects invalid cache mode %# before fetching without echoing values', async cacheMode => {
  expect(() => normalizeJevConfig({ cacheMode })).toThrow('Invalid Jev cache mode');
  await expect(classifyJev({ cacheMode }, { state: 'x', questions })).rejects.toThrow('Invalid Jev cache mode');
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each(['X-AutoJev-Cache-Mode', 'x-autojev-cache-mode', 'X-AUTOJEV-CACHE-MODE', 'x-AuToJeV-CaChE-mOdE'])('reserves custom %s for every mode', async name => {
  for (const cacheMode of ['server', 'none', 'options', 'context']) {
    await expect(classifyJev({ cacheMode, headers: { [name]: 'context' } }, { questions })).rejects.toThrow('Invalid or reserved Jev header');
  }
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  { 'X-Client': 'a', 'x-client': 'b' },
  { 'X-AutoJev-Prefix-Cache': 'true', 'x-autojev-prefix-cache': 'false' },
  { 'X-Client': 'non-byte-🙂' },
])('shared header rules reject case collisions and non-byte values %#', headers => {
  expect(() => normalizeJevConfig({ headers })).toThrow('Invalid or reserved Jev header');
});

test('shared header validation retains HTTP byte-string values', () => {
  expect(normalizeJevConfig({ headers: { 'X-Client': 'café' } }).headers).toEqual({ 'X-Client': 'café' });
});

test.each(['true', 'false'])('legacy prefix-cache %s remains present alongside explicit mode', async value => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: 'CLICK' } }) });
  await classifyJev({ cacheMode: 'context', headers: { 'X-AutoJev-Prefix-Cache': value } }, { questions });
  expect(global.fetch.mock.calls[0][1].headers['X-AutoJev-Prefix-Cache']).toBe(value);
  expect(global.fetch.mock.calls[0][1].headers['X-AutoJev-Cache-Mode']).toBe('context');
});

test.each(['server', 'none', 'options', 'context'])('connection test honors cache mode %s', async cacheMode => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { connection: 'READY' } }) });
  await expect(testJevConnection({ cacheMode })).resolves.toEqual({ ok: true });
  const headers = global.fetch.mock.calls[0][1].headers;
  expect(headers['X-AutoJev-Cache-Mode']).toBe(cacheMode === 'server' ? undefined : cacheMode);
});

test.each(['server', 'none', 'options', 'context'])('sends one controlled mode header over HTTP for %s, except server', async cacheMode => {
  global.fetch = originalFetch;
  const received = [];
  const server = createServer((request, response) => {
    received.push(request);
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ answers: { connection: 'READY' } }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await expect(testJevConnection({
      baseUrl: `http://127.0.0.1:${server.address().port}`, cacheMode, apiKey: 'fixture-key',
      headers: { 'X-AutoJev-Prefix-Cache': 'false' }, timeoutMs: 1000,
    })).resolves.toEqual({ ok: true });
    expect(received).toHaveLength(1);
    const request = received[0];
    expect(request.headers['x-autojev-cache-mode']).toBe(cacheMode === 'server' ? undefined : cacheMode);
    expect(request.rawHeaders.filter(value => value.toLowerCase() === 'x-autojev-cache-mode')).toHaveLength(cacheMode === 'server' ? 0 : 1);
    expect(request.headers['x-autojev-prefix-cache']).toBe('false');
    expect(request.headers.authorization).toBe('Bearer fixture-key');
    expect(request.url).toBe('/v1/systemone');
  } finally {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
});

test('posts the inspected contract with top-level data URI images and extra params', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: { choice: 'CLICK', confidence: .9, probabilities: {} } }, usage: {} }) });
  const result = await classifyJev({ apiKey: 'private-key', headers: { 'X-Client': 'fixture' }, requestParams: { temperature: 0 } }, { state: { goal: 'click' }, questions, images: ['data:image/png;base64,YQ=='] });
  expect(result).toEqual({ action: 'CLICK' });
  const [url, request] = global.fetch.mock.calls[0];
  expect(url).toBe('http://localhost:8765/v1/systemone');
  expect(request.headers.Authorization).toBe('Bearer private-key');
  expect(request.headers['X-AutoJev-Cache-Mode']).toBeUndefined();
  expect(request.redirect).toBe('error');
  expect(JSON.parse(request.body)).toEqual({ model: 'jev-latest', state: { goal: 'click' }, questions, images: ['data:image/png;base64,YQ=='], temperature: 0 });
});

test.each([{}, { answers: { action: { choice: 'INVENTED' } } }, { answers: { action: { confidence: 1 } } }])('rejects malformed or unlisted answers %#', async data => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => data });
  await expect(classifyJev({}, { state: 'x', questions })).rejects.toThrow();
});

test('rejects an actual cross-origin 307 without forwarding headers or page context', async () => {
  global.fetch = originalFetch;
  let targetRequests = 0;
  let sourceRequests = 0;
  const target = createServer((request, response) => {
    targetRequests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ answers: { action: 'CLICK' } }));
  });
  const source = createServer((request, response) => {
    sourceRequests++;
    request.resume();
    response.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/collect` });
    response.end();
  });
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });
  try {
    await listen(target); await listen(source);
    await expect(classifyJev({
      baseUrl: `http://127.0.0.1:${source.address().port}`,
      apiKey: 'private-key', headers: { 'X-Private-Header': 'private-header' }, timeoutMs: 1000,
    }, { state: 'private-page-context', questions })).rejects.toThrow('Jev request failed');
    expect(sourceRequests).toBe(1);
    expect(targetRequests).toBe(0);
  } finally {
    await Promise.all([close(source), close(target)]);
  }
});

test('BLOCKED is a valid answer', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: 'BLOCKED' } }) });
  await expect(classifyJev({}, { state: 'x', questions })).resolves.toEqual({ action: 'BLOCKED' });
});

test('does not read or expose HTTP error bodies', async () => {
  const response = { ok: false, status: 401, text: jest.fn().mockResolvedValue('private-key') };
  global.fetch.mockResolvedValue(response);
  await expect(classifyJev({ apiKey: 'private-key' }, { state: 'x', questions })).rejects.toThrow('Jev HTTP 401');
  expect(response.text).not.toHaveBeenCalled();
});

test('redacts transport and JSON errors', async () => {
  global.fetch.mockRejectedValue(new Error('private-key'));
  await expect(classifyJev({}, { state: 'x', questions })).rejects.toThrow('Jev request failed');
  global.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('private-key'); } });
  await expect(classifyJev({}, { state: 'x', questions })).rejects.toThrow('Jev request failed');
});

test('redacts transport errors even if they are JevError-shaped', async () => {
  global.fetch.mockRejectedValue(Object.assign(new JevError('private-key'), { body: 'private-body' }));
  await expect(classifyJev({}, { state: 'x', questions })).rejects.toThrow('Jev request failed');
});

test('bounds stalled requests even when fetch ignores abort', async () => {
  jest.useFakeTimers();
  global.fetch.mockImplementation(() => new Promise(() => {}));
  const result = classifyJev({ timeoutMs: 10 }, { state: 'x', questions });
  const rejection = expect(result).rejects.toThrow('Jev request timed out');
  await jest.advanceTimersByTimeAsync(10);
  await rejection;
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('external abort cancels and never masquerades as an outage', async () => {
  global.fetch.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = classifyJev({}, { state: 'x', questions, signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});

test('pre-aborted request never fetches', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(classifyJev({}, { state: 'x', questions, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('limits choice counts and validates images before fetch', async () => {
  const excessive = { action: { ...questions.action, criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`E${i}`, 'element'])) } };
  await expect(classifyJev({}, { questions: excessive })).rejects.toThrow('Invalid choice question');
  await expect(classifyJev({}, { questions, images: ['https://host/image.png'] })).rejects.toThrow('Invalid or oversized Jev image');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('known image dimensions enforce the 16MP request limit before network access', async () => {
  const bytes = Buffer.alloc(24);
  bytes.write('PNG', 1); bytes.write('IHDR', 12); bytes.writeUInt32BE(5000, 16); bytes.writeUInt32BE(5000, 20);
  const image = `data:image/png;base64,${bytes.toString('base64')}`;
  await expect(classifyJev({}, { questions, images: [image] })).rejects.toThrow('Jev images exceed request limits');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('default timeout follows AutoJev loading/queue guidance and permits one hour', () => {
  expect(normalizeJevConfig({}).timeoutMs).toBe(1200000);
  expect(normalizeJevConfig({ timeoutMs: 3600000 }).timeoutMs).toBe(3600000);
  expect(() => normalizeJevConfig({ timeoutMs: 3600001 })).toThrow('Invalid Jev timeout');
});

function pngImage(byteCount, width = 1000, height = 1000) {
  const bytes = Buffer.alloc(byteCount);
  bytes.write('PNG', 1); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('8,000,000 decoded bytes is accepted; one byte more is rejected', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: 'CLICK' } }) });
  await expect(classifyJev({}, { state: '', questions, images: [pngImage(8000000)] })).resolves.toEqual({ action: 'CLICK' });
  global.fetch.mockClear();
  await expect(classifyJev({}, { state: '', questions, images: [pngImage(8000001)] })).rejects.toThrow('Jev images exceed request limits');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('image limits are per image, not an aggregate byte/pixel cap', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: 'CLICK' } }) });
  const image = pngImage(4000001, 4000, 4000); // 16MP each; combined bytes > 8MB and pixels > 16MP
  await expect(classifyJev({}, { state: '', questions, images: [image, image] })).resolves.toEqual({ action: 'CLICK' });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).images).toHaveLength(2);
});

test('connection probe uses choice API and exported constructor alias', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { connection: { choice: 'READY' } } }) });
  await expect(testJevConnection({})).resolves.toEqual({ ok: true });
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.questions.connection.criteria).toEqual({ READY: 'The connection is working.' });
  expect(body.images).toBeUndefined();
  expect(BrowserAgent).toBe(AgentCore);
});
