import { jest } from '@jest/globals';
import { OpenAIProvider } from '../../background/llm/openai.js';
import { AnthropicProvider } from '../../background/llm/anthropic.js';
import { OllamaProvider } from '../../background/llm/ollama.js';
import { OpenRouterProvider } from '../../background/llm/openrouter.js';
import { NvidiaProvider } from '../../background/llm/nvidia.js';
import { LLMError } from '../../background/llm/utils.js';

// ── shared helpers ────────────────────────────────────────────────────────────

const SCREENSHOT = 'data:image/png;base64,iVBORw0KGgo=';

function mockOkFetch(data) {
  global.fetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockErrorFetch(status = 401) {
  global.fetch.mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve('Unauthorized'),
  });
}

const OPENAI_OK = { choices: [{ message: { content: 'test response' } }] };
const ANTHROPIC_OK = { content: [{ text: 'test response' }] };

// ── OpenAI ────────────────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('calls_correct_endpoint', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenAIProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.any(Object),
    );
  });

  test('sends_auth_in_header', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenAIProvider({ apiKey: 'my-key' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-key');
  });

  test('includes_screenshot_when_provided', async () => {
    mockOkFetch(OPENAI_OK);
    // gpt-4o (default) supports vision.
    const p = new OpenAIProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: SCREENSHOT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(expect.objectContaining({ type: 'image_url' }));
  });

  test('omits_screenshot_when_null', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenAIProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(typeof last.content).toBe('string');
  });

  test('returns_text_content', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenAIProvider({ apiKey: 'k' });
    const result = await p.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      screenshot: null,
    });
    expect(result).toBe('test response');
  });

  test('throws_on_non_200', async () => {
    mockErrorFetch(401);
    const p = new OpenAIProvider({ apiKey: 'k' });
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null }),
    ).rejects.toThrow(LLMError);
  });
});

// ── Anthropic ─────────────────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('calls_correct_endpoint', async () => {
    mockOkFetch(ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.any(Object),
    );
  });

  test('sends_auth_in_header', async () => {
    mockOkFetch(ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'my-key' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('my-key');
  });

  test('includes_screenshot_when_provided', async () => {
    mockOkFetch(ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: SCREENSHOT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(expect.objectContaining({ type: 'image' }));
  });

  test('omits_screenshot_when_null', async () => {
    mockOkFetch(ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    // No image block when screenshot is null.
    const hasImage = Array.isArray(last.content) && last.content.some((c) => c.type === 'image');
    expect(hasImage).toBe(false);
  });

  test('returns_text_content', async () => {
    mockOkFetch(ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'k' });
    const result = await p.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      screenshot: null,
    });
    expect(result).toBe('test response');
  });

  test('throws_on_non_200', async () => {
    mockErrorFetch(401);
    const p = new AnthropicProvider({ apiKey: 'k' });
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null }),
    ).rejects.toThrow(LLMError);
  });
});

// ── Ollama ────────────────────────────────────────────────────────────────────

describe('OllamaProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('calls_correct_endpoint', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OllamaProvider();
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.any(Object),
    );
  });

  test('sends_auth_in_header', async () => {
    // Ollama has no auth — just verify Content-Type is set.
    mockOkFetch(OPENAI_OK);
    const p = new OllamaProvider();
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('includes_screenshot_when_provided', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OllamaProvider({ model: 'llava' }); // llava supports vision
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: SCREENSHOT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(expect.objectContaining({ type: 'image_url' }));
  });

  test('omits_screenshot_when_null', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OllamaProvider();
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(typeof last.content).toBe('string');
  });

  test('returns_text_content', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OllamaProvider();
    const result = await p.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      screenshot: null,
    });
    expect(result).toBe('test response');
  });

  test('throws_on_non_200', async () => {
    mockErrorFetch(401);
    const p = new OllamaProvider();
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null }),
    ).rejects.toThrow(LLMError);
  });
});

// ── OpenRouter ────────────────────────────────────────────────────────────────

describe('OpenRouterProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('calls_correct_endpoint', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenRouterProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.any(Object),
    );
  });

  test('sends_auth_in_header', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenRouterProvider({ apiKey: 'my-key' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-key');
  });

  test('includes_screenshot_when_provided', async () => {
    mockOkFetch(OPENAI_OK);
    // openai/gpt-4o matches the vision pattern (contains 'gpt-4o').
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'openai/gpt-4o' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: SCREENSHOT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(expect.objectContaining({ type: 'image_url' }));
  });

  test('omits_screenshot_when_null', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenRouterProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(typeof last.content).toBe('string');
  });

  test('returns_text_content', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new OpenRouterProvider({ apiKey: 'k' });
    const result = await p.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      screenshot: null,
    });
    expect(result).toBe('test response');
  });

  test('throws_on_non_200', async () => {
    mockErrorFetch(401);
    const p = new OpenRouterProvider({ apiKey: 'k' });
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null }),
    ).rejects.toThrow(LLMError);
  });
});

// ── Nvidia ────────────────────────────────────────────────────────────────────

describe('NvidiaProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('calls_correct_endpoint', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new NvidiaProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    expect(fetch).toHaveBeenCalledWith(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      expect.any(Object),
    );
  });

  test('sends_auth_in_header', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new NvidiaProvider({ apiKey: 'my-key' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-key');
  });

  test('includes_screenshot_when_provided', async () => {
    mockOkFetch(OPENAI_OK);
    // Use a model name matching /vision|vl/i.
    const p = new NvidiaProvider({ apiKey: 'k', model: 'nvidia-vision-model' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: SCREENSHOT });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toContainEqual(expect.objectContaining({ type: 'image_url' }));
  });

  test('omits_screenshot_when_null', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new NvidiaProvider({ apiKey: 'k' });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(typeof last.content).toBe('string');
  });

  test('returns_text_content', async () => {
    mockOkFetch(OPENAI_OK);
    const p = new NvidiaProvider({ apiKey: 'k' });
    const result = await p.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      screenshot: null,
    });
    expect(result).toBe('test response');
  });

  test('throws_on_non_200', async () => {
    mockErrorFetch(401);
    const p = new NvidiaProvider({ apiKey: 'k' });
    await expect(
      p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], screenshot: null }),
    ).rejects.toThrow(LLMError);
  });
});
