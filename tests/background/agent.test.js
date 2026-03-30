import { jest } from '@jest/globals';
import { AgentCore } from '../../background/agent.js';

// ── mock factories ────────────────────────────────────────────────────────────

const DEFAULT_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Test',
  elements: [],
  context: {},
  viewportWidth: 1280,
  viewportHeight: 720,
  pageWidth: 1280,
  pageHeight: 2000,
};

function createMockBridge(overrides = {}) {
  return {
    getActiveTabId: jest.fn().mockResolvedValue(1),
    getPageState: jest.fn().mockResolvedValue(DEFAULT_PAGE_STATE),
    takeScreenshot: jest.fn().mockResolvedValue(null),
    navigate: jest.fn().mockResolvedValue(undefined),
    waitForPageSettle: jest.fn().mockResolvedValue(undefined),
    sendStatus: jest.fn(),
    ...overrides,
  };
}

function createMockExecutor() {
  return { execute: jest.fn().mockResolvedValue(undefined) };
}

/** Returns an LLM mock that yields each value in sequence, then repeats the last. */
function makeLLM(...responses) {
  const llm = { complete: jest.fn() };
  let calls = 0;
  llm.complete.mockImplementation(() => {
    const val = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return Promise.resolve(val);
  });
  return llm;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AgentCore', () => {
  test('test_done_on_first_response', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(JSON.stringify({ done: true, message: 'ok' }));

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      onStatus: (s) => statuses.push(s.state),
    });

    const result = await agent.run('do something');

    expect(result).toBe('ok');
    expect(statuses).toContain('done');
  });

  test('test_loop_runs_until_done', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(
      JSON.stringify({ done: false, actions: [{ command: 'mouse_click', params: { x: 1, y: 1 } }] }),
      JSON.stringify({ done: false, actions: [{ command: 'mouse_click', params: { x: 2, y: 2 } }] }),
      JSON.stringify({ done: true, message: 'done' }),
    );

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do something');

    expect(llm.complete).toHaveBeenCalledTimes(3);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  test('test_max_iterations_respected', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(JSON.stringify({ done: false, actions: [] }));

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      maxIterations: 3,
      onStatus: (s) => statuses.push(s.state),
    });

    await agent.run('loop forever');

    expect(llm.complete).toHaveBeenCalledTimes(3);
    expect(statuses).toContain('error');
  });

  test('test_url_extracted_and_navigated', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(JSON.stringify({ done: true, message: 'ok' }));

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('login at https://example.com');

    expect(bridge.navigate).toHaveBeenCalledWith('https://example.com');
  });

  test('test_no_url_skips_navigate', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(JSON.stringify({ done: true, message: 'ok' }));

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('click the button');

    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  test('test_stop_aborts_loop', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(JSON.stringify({ done: false, actions: [] }));

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      maxIterations: 20,
      onStatus: (s) => statuses.push(s.state),
    });

    // Call stop during the second getPageState so the next iteration's check catches it.
    let pageStateCount = 0;
    bridge.getPageState.mockImplementation(async () => {
      pageStateCount++;
      if (pageStateCount >= 2) agent.stop();
      return DEFAULT_PAGE_STATE;
    });

    await agent.run('do something');

    expect(statuses).toContain('stopped');
    expect(statuses).not.toContain('error');
  });

  test('test_status_reported_on_each_state', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(
      JSON.stringify({ done: false, actions: [{ command: 'mouse_click', params: { x: 1, y: 1 } }] }),
      JSON.stringify({ done: true, message: 'ok' }),
    );

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      onStatus: (s) => statuses.push(s.state),
    });

    await agent.run('do something');

    // Verify all expected phases appear and in relative order.
    const runIdx = statuses.indexOf('running');
    const thinkIdx = statuses.indexOf('thinking');
    const actIdx = statuses.indexOf('acting');
    const doneIdx = statuses.lastIndexOf('done');

    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(thinkIdx).toBeGreaterThan(runIdx);
    expect(actIdx).toBeGreaterThan(thinkIdx);
    expect(doneIdx).toBeGreaterThan(actIdx);
  });

  test('test_screenshot_requested_when_vision_enabled', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(JSON.stringify({ done: true, message: 'ok' }));

    const agent = new AgentCore({ bridge, executor, llm, useVision: true, onStatus: () => {} });
    await agent.run('do something');

    expect(bridge.takeScreenshot).toHaveBeenCalled();
  });

  test('test_screenshot_skipped_when_vision_disabled', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(JSON.stringify({ done: true, message: 'ok' }));

    const agent = new AgentCore({ bridge, executor, llm, useVision: false, onStatus: () => {} });
    await agent.run('do something');

    expect(bridge.takeScreenshot).not.toHaveBeenCalled();
  });

  test('test_retry_on_parse_failure', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(
      'this is not json at all !!!',
      JSON.stringify({ done: true, message: 'x' }),
    );

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    const result = await agent.run('do something');

    expect(result).toBe('x');
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  test('test_error_on_double_parse_failure', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM('not json', 'still not json');

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      onStatus: (s) => statuses.push(s.state),
    });

    await agent.run('do something');

    expect(statuses).toContain('error');
  });
});
