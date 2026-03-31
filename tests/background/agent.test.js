import { jest } from '@jest/globals';
import { AgentCore } from '../../background/agent.js';

// ── mock factories ────────────────────────────────────────────────────────────

const DEFAULT_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Test',
  domText: '[Start of page]\n[0]<button>Click me</button>\n[1]<button>Other</button>\n[End of visible area]',
  elements: [
    { index: 0, rect: { x: 100, y: 100, w: 200, h: 40 }, inViewport: true, text: 'Click me', attrs: {} },
    { index: 1, rect: { x: 100, y: 200, w: 200, h: 40 }, inViewport: true, text: 'Other', attrs: {} },
  ],
  context: {},
  viewportWidth: 1280,
  viewportHeight: 720,
  pageWidth: 1280,
  pageHeight: 2000,
  scrollX: 0,
  scrollY: 0,
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

function makeDoneResponse(message = 'ok') {
  return JSON.stringify({
    evaluation_previous_goal: 'N/A - first step',
    memory: 'Starting task.',
    next_goal: 'Done.',
    action: { done: { success: true, message } },
  });
}

function makeClickResponse(index = 0) {
  return JSON.stringify({
    evaluation_previous_goal: 'Loaded page successfully.',
    memory: 'On the page, need to click.',
    next_goal: `Click element ${index}.`,
    action: { click: { index } },
  });
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(global, 'setTimeout').mockImplementation((cb) => { cb(); return 0; });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AgentCore', () => {
  test('test_done_on_first_response', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(makeDoneResponse('ok'));

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
      makeClickResponse(0),
      makeClickResponse(1),
      makeDoneResponse('done'),
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
    const llm = makeLLM(makeClickResponse(0));

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
    const llm = makeLLM(makeDoneResponse('ok'));

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('login at https://example.com');

    expect(bridge.navigate).toHaveBeenCalledWith('https://example.com');
  });

  test('test_no_url_skips_navigate', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeDoneResponse('ok'));

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('click the button');

    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  test('test_stop_aborts_loop', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(makeClickResponse(0));

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      maxIterations: 20,
      onStatus: (s) => statuses.push(s.state),
    });

    // Stop the agent on the second getPageState call so the next iteration's
    // stop-check catches it.
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

  test('test_action_result_recorded_on_success', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const captured = [];
    let call = 0;
    const llm = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      call++;
      return Promise.resolve(call === 1 ? makeClickResponse(0) : makeDoneResponse('ok'));
    }) };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // Step 2 message must contain the action result from step 1
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[1]).toContain('Executed click');
    expect(captured[1]).toContain('"index":0');
  });

  test('test_status_reported_on_each_state', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const statuses = [];
    const llm = makeLLM(
      makeClickResponse(0),
      makeDoneResponse('ok'),
    );

    const agent = new AgentCore({
      bridge,
      executor,
      llm,
      onStatus: (s) => statuses.push(s.state),
    });

    await agent.run('do something');

    const runIdx   = statuses.indexOf('running');
    const thinkIdx = statuses.indexOf('thinking');
    const actIdx   = statuses.indexOf('acting');
    const doneIdx  = statuses.lastIndexOf('done');

    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(thinkIdx).toBeGreaterThan(runIdx);
    expect(actIdx).toBeGreaterThan(thinkIdx);
    expect(doneIdx).toBeGreaterThan(actIdx);
  });

  test('test_screenshot_requested_when_vision_enabled', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeDoneResponse('ok'));

    const agent = new AgentCore({ bridge, executor, llm, useVision: true, onStatus: () => {} });
    await agent.run('do something');

    expect(bridge.takeScreenshot).toHaveBeenCalled();
  });

  test('test_screenshot_skipped_when_vision_disabled', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeDoneResponse('ok'));

    const agent = new AgentCore({ bridge, executor, llm, useVision: false, onStatus: () => {} });
    await agent.run('do something');

    expect(bridge.takeScreenshot).not.toHaveBeenCalled();
  });

  test('test_retry_on_parse_failure', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(
      'this is not json at all !!!',
      makeDoneResponse('x'),
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

  test('test_history_accumulated_as_summaries', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(
      makeClickResponse(0),
      makeClickResponse(1),
      makeDoneResponse('done'),
    );

    const capturedMessages = [];
    llm.complete.mockImplementation(({ messages }) => {
      capturedMessages.push(messages);
      // Return responses in order
      const idx = capturedMessages.length - 1;
      const responses = [makeClickResponse(0), makeClickResponse(1), makeDoneResponse('done')];
      return Promise.resolve(responses[Math.min(idx, responses.length - 1)]);
    });

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // The third call (step 2) should have <agent_history> with summaries from steps 0 and 1
    expect(capturedMessages.length).toBeGreaterThanOrEqual(3);
    const thirdCallMsg = capturedMessages[2][0].content;
    expect(thirdCallMsg).toContain('<agent_history>');
    expect(thirdCallMsg).toContain('<step_0>');
    expect(thirdCallMsg).toContain('<step_1>');
  });

  test('test_executor_called_with_single_action_object', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(
      makeClickResponse(0),
      makeDoneResponse('done'),
    );

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [actionArg] = executor.execute.mock.calls[0];
    expect(actionArg).toEqual({ click: { index: 0 } });
  });

  // ── validation tests ────────────────────────────────────────────────────────

  test('test_invalid_index_retries_llm', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    // First response uses index 5 (doesn't exist); second uses index 0 (valid)
    const llm = makeLLM(
      makeClickResponse(5),   // bad
      makeClickResponse(0),   // good (retry response)
      makeDoneResponse('ok'), // next step
    );

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // LLM was called at least twice for the first step (original + validation retry)
    expect(llm.complete).toHaveBeenCalledTimes(3);
  });

  test('test_invalid_index_sends_helpful_error_to_llm', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const captured = [];
    const llm = { complete: jest.fn() };
    llm.complete
      .mockResolvedValueOnce(makeClickResponse(5))   // bad index
      .mockImplementation(({ messages }) => {
        captured.push(messages);
        return Promise.resolve(makeDoneResponse('ok'));
      });

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // The retry message must mention the bad index and the valid ones
    const retryUserMsg = captured[0].find(m => m.role === 'user' && m.content.includes('Invalid action'));
    expect(retryUserMsg).toBeDefined();
    expect(retryUserMsg.content).toContain('5');
    expect(retryUserMsg.content).toContain('0');
    expect(retryUserMsg.content).toContain('1');
  });

  test('test_valid_index_does_not_trigger_retry', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeClickResponse(0), makeDoneResponse('ok'));

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // Exactly 2 LLM calls: one per step, no validation retries
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  // ── loop detection tests ──────────────────────────────────────────────────────

  test('test_loop_detected_when_same_action_on_same_url_twice', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const captured = [];
    let call = 0;
    const llm = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      call++;
      // Always return click(0) so we get the same action twice
      if (call <= 2) return Promise.resolve(makeClickResponse(0));
      return Promise.resolve(makeDoneResponse('ok'));
    }) };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // Third LLM call should see LOOP DETECTED in history
    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(captured[2]).toContain('LOOP DETECTED');
  });

  test('test_no_loop_warning_when_actions_differ', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const captured = [];
    let call = 0;
    const llm = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      call++;
      // Alternate between index 0 and index 1
      if (call === 1) return Promise.resolve(makeClickResponse(0));
      if (call === 2) return Promise.resolve(makeClickResponse(1));
      return Promise.resolve(makeDoneResponse('ok'));
    }) };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // No loop warning should appear
    if (captured.length >= 3) {
      expect(captured[2]).not.toContain('LOOP DETECTED');
    }
  });

  test('test_loop_resets_on_new_run', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeClickResponse(0), makeDoneResponse('ok'));
    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('first run');
    // second run should start fresh — no loop warning on first step
    const captured = [];
    const llm2 = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      return Promise.resolve(makeDoneResponse('ok'));
    }) };
    agent._llm = llm2;
    await agent.run('second run');
    expect(captured[0]).not.toContain('LOOP DETECTED');
  });

  test('test_executor_error_is_recoverable_and_agent_continues', async () => {
    const bridge = createMockBridge();
    const statuses = [];
    const llm = makeLLM(makeClickResponse(0), makeDoneResponse('ok'));
    // Executor throws ExecutorError on first call, succeeds on second
    const executor = {
      execute: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Unknown element index 0'), { name: 'ExecutorError' }))
        .mockResolvedValue(undefined),
    };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: (s) => statuses.push(s.state) });
    await agent.run('do task');

    // Agent should NOT have emitted a terminal error; it should have continued
    expect(statuses).toContain('done');
    // LLM was called twice (two steps)
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  test('test_executor_error_message_appears_in_history', async () => {
    const bridge = createMockBridge();
    const captured = [];
    const executor = {
      execute: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Unknown element index 0. Page has 2 elements'), { name: 'ExecutorError' }))
        .mockResolvedValue(undefined),
    };
    // First call returns a click action (so executor is invoked); second returns done.
    let callCount = 0;
    const llm = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      callCount++;
      return Promise.resolve(callCount === 1 ? makeClickResponse(0) : makeDoneResponse('ok'));
    }) };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    // The second LLM call (step 1) should see the executor error in agent_history
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const secondCallMsg = captured[1];
    expect(secondCallMsg).toContain('Action failed');
    expect(secondCallMsg).toContain('Unknown element index 0');
  });

  test('test_user_message_contains_valid_indices_list', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const captured = [];
    const llm = { complete: jest.fn().mockImplementation(({ messages }) => {
      captured.push(messages[0].content);
      return Promise.resolve(makeDoneResponse('ok'));
    }) };

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do task');

    expect(captured[0]).toContain('Valid element indices on this page: [0, 1]');
  });

  test('test_user_message_has_agent_state_section', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeDoneResponse('ok'));

    const capturedMessages = [];
    llm.complete.mockImplementation(({ messages }) => {
      capturedMessages.push(messages);
      return Promise.resolve(makeDoneResponse('ok'));
    });

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('my special task');

    const userMsg = capturedMessages[0][0].content;
    expect(userMsg).toContain('<agent_state>');
    expect(userMsg).toContain('my special task');
    expect(userMsg).toContain('<step_info>');
  });

  test('test_user_message_has_browser_state_section', async () => {
    const bridge = createMockBridge();
    const executor = createMockExecutor();
    const llm = makeLLM(makeDoneResponse('ok'));

    const capturedMessages = [];
    llm.complete.mockImplementation(({ messages }) => {
      capturedMessages.push(messages);
      return Promise.resolve(makeDoneResponse('ok'));
    });

    const agent = new AgentCore({ bridge, executor, llm, onStatus: () => {} });
    await agent.run('do something');

    const userMsg = capturedMessages[0][0].content;
    expect(userMsg).toContain('<browser_state>');
    // domText content from DEFAULT_PAGE_STATE should be present
    expect(userMsg).toContain('Click me');
    expect(userMsg).toContain('https://example.com');
  });
});
