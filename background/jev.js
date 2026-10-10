// AutoJev /v1/systemone choice API. Never include server bodies or credentials in errors.
export class JevError extends Error {
  constructor(message) { super(message); this.name = 'JevError'; }
}

const TURN_ERRORS = new Set([
  'Jev request failed', 'Jev request timed out', 'Invalid classification response',
  'Classification returned an unlisted choice', 'Invalid or oversized Jev image',
  'Jev images exceed request limits', 'Invalid Jev image encoding', 'Jev context exceeds conservative local budget',
  'Decision helper request failed', 'Decision helper timed out',
  'Normal LLM fallback returned invalid choices', 'Decision helper returned invalid parameters',
  'Chosen target is not in the current snapshot', 'Invalid staged action', 'Staged action failed local validation',
]);

export function publicJevTurnError(error) {
  // Reconstruct rather than forwarding side fields, raw provider bodies or stacks.
  const message = error instanceof JevError && (TURN_ERRORS.has(error.message) || /^Jev HTTP \d{1,3}$/.test(error.message))
    ? error.message : 'Browser decision turn failed';
  return new JevError(message);
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const RESERVED_PARAMS = new Set(['state', 'questions', 'images', 'model', '__proto__', 'constructor', 'prototype']);
const RESERVED_HEADERS = /^(authorization|content-(?:type|length|encoding)|host|cookie|origin|referer|connection|transfer-encoding|te|trailer|upgrade|accept-encoding|accept-charset|user-agent|x-autojev-cache-mode|proxy-.*|sec-.*)$/i;

// Read dimensions without decoding pixels. Invalid files still fail at the API.
function imagePixels(data) {
  const b = i => data.charCodeAt(i);
  const u16 = i => b(i) * 256 + b(i + 1);
  const u32 = i => (b(i) * 0x1000000 + b(i + 1) * 0x10000 + b(i + 2) * 256 + b(i + 3));
  if (data.length >= 24 && data.slice(1, 4) === 'PNG' && data.slice(12, 16) === 'IHDR') return u32(16) * u32(20);
  if (data.length >= 4 && b(0) === 255 && b(1) === 216) {
    let i = 2;
    while (i + 9 < data.length) {
      if (b(i++) !== 255) break;
      while (b(i) === 255) i++;
      const marker = b(i++);
      if (marker === 217 || marker === 218) break;
      const size = u16(i);
      if (size < 2 || i + size > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return u16(i + 3) * u16(i + 5);
      i += size;
    }
  }
  if (data.length >= 30 && data.slice(0, 4) === 'RIFF' && data.slice(8, 12) === 'WEBP') {
    if (data.slice(12, 16) === 'VP8X') return (1 + b(24) + b(25) * 256 + b(26) * 65536) * (1 + b(27) + b(28) * 256 + b(29) * 65536);
    if (data.slice(12, 16) === 'VP8 ' && b(23) === 157 && b(24) === 1 && b(25) === 42) return ((b(26) + b(27) * 256) & 16383) * ((b(28) + b(29) * 256) & 16383);
  }
  if (data.length >= 25 && data.slice(12, 16) === 'VP8L' && b(20) === 47) return (1 + b(21) + ((b(22) & 63) << 8)) * (1 + (b(22) >> 6) + (b(23) << 2) + ((b(24) & 15) << 10));
  return 0;
}

export function normalizeJevConfig(config = {}) {
  if (!object(config)) throw new JevError('Invalid Jev configuration');
  let url;
  try { url = new URL(config.baseUrl || 'http://localhost:8765'); }
  catch { throw new JevError('Invalid Jev endpoint URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new JevError('Jev endpoint must be an HTTP(S) URL without credentials, query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1/systemone') ? path : path.endsWith('/v1') ? `${path}/systemone` : `${path}/v1/systemone`;
  const timeoutMs = config.timeoutMs ?? 1200000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new JevError('Invalid Jev timeout');
  // Standalone embedders retain server/legacy defaults; the extension selects context.
  const cacheMode = config.cacheMode === undefined ? 'server' : config.cacheMode;
  if (!['server', 'none', 'options', 'context'].includes(cacheMode)) throw new JevError('Invalid Jev cache mode');
  const headers = config.headers ?? {};
  const requestParams = config.requestParams ?? {};
  if (!object(headers) || !object(requestParams)) throw new JevError('Jev headers and request params must be objects');
  const headerNames = new Set();
  for (const [key, value] of Object.entries(headers)) {
    const lowerName = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || RESERVED_HEADERS.test(key) || headerNames.has(lowerName) || typeof value !== 'string' || /[\u0000-\u001f\u007f\u0100-\uffff]/.test(value)) {
      throw new JevError('Invalid or reserved Jev header');
    }
    headerNames.add(lowerName);
  }
  if (Object.keys(requestParams).some(key => RESERVED_PARAMS.has(key))) throw new JevError('Reserved Jev request parameter');
  try { JSON.stringify(requestParams); } catch { throw new JevError('Jev request params must be JSON serializable'); }
  if (config.apiKey != null && (typeof config.apiKey !== 'string' || /[\u0000-\u001f\u007f]/.test(config.apiKey))) throw new JevError('Invalid Jev API key');
  if (config.model != null && (typeof config.model !== 'string' || !config.model.trim())) throw new JevError('Invalid Jev model');
  if (config.fallbackEnabled != null && typeof config.fallbackEnabled !== 'boolean') throw new JevError('Invalid Jev fallback setting');
  return { endpoint: url.href, apiKey: config.apiKey || '', model: config.model || 'jev-latest', cacheMode, headers: { ...headers }, requestParams: { ...requestParams }, timeoutMs, fallbackEnabled: config.fallbackEnabled ?? true };
}

export function validateChoices(answers, questions) {
  if (!object(answers)) throw new JevError('Invalid classification response');
  const result = {};
  for (const [id, question] of Object.entries(questions)) {
    const choice = typeof answers[id] === 'string' ? answers[id] : answers[id]?.choice;
    if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) throw new JevError('Classification returned an unlisted choice');
    result[id] = choice;
  }
  return result;
}

export async function classifyJev(config, { state, questions, images = [], signal, validateAnswers = validateChoices } = {}) {
  const c = normalizeJevConfig(config);
  if (!object(questions) || !Object.keys(questions).length) throw new JevError('Missing classification questions');
  for (const q of Object.values(questions)) {
    if (q.type !== 'choice' || !object(q.criteria) || !Object.keys(q.criteria).length || Object.keys(q.criteria).length > 255) throw new JevError('Invalid choice question');
  }
  if (!Array.isArray(images) || images.length > 4 || images.some(im => typeof im !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(im))) {
    throw new JevError('Invalid or oversized Jev image');
  }
  try {
    for (const image of images) {
      const data = atob(image.slice(image.indexOf(',') + 1));
      if (data.length > 8000000 || imagePixels(data) > 16000000) throw new JevError('Jev images exceed request limits');
    }
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError('Invalid Jev image encoding');
  }
  const controller = new AbortController();
  const aborted = () => { const e = new Error('Jev request cancelled'); e.name = 'AbortError'; return e; };
  if (signal?.aborted) throw aborted();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  let timer;
  try {
    // Race the request as well as passing a signal, so stalled/mocked fetches are bounded.
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(timedOut ? new JevError('Jev request timed out') : aborted()), { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, c.timeoutMs);
    });
    const request = (async () => {
      let res;
      try { res = await fetch(c.endpoint, {
        // Never forward credentials, custom headers or page state to redirects.
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...c.headers, 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}), ...(c.cacheMode !== 'server' ? { 'X-AutoJev-Cache-Mode': c.cacheMode } : {}) },
        body: JSON.stringify({ ...c.requestParams, model: c.model, state, questions, ...(images.length ? { images } : {}) }),
      }); } catch { throw new JevError('Jev request failed'); }
      if (!res.ok) throw new JevError(`Jev HTTP ${Number(res.status) || 0}`);
      let data;
      try { data = await res.json(); } catch { throw new JevError('Jev request failed'); }
      return validateAnswers(data?.answers, questions);
    })();
    return await Promise.race([request, cancelled]);
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (timedOut) throw new JevError('Jev request timed out');
    if (error instanceof JevError) throw error;
    throw new JevError('Jev request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function testJevConnection(config, { signal } = {}) {
  const result = await classifyJev(config, {
    state: 'Connection test. Choose READY.',
    questions: { connection: { type: 'choice', instructions: 'Choose READY.', criteria: { READY: 'The connection is working.' } } },
    signal,
  });
  return { ok: result.connection === 'READY' };
}
