import { jest } from '@jest/globals';
import { ActionExecutor, ExecutorError } from '../../background/executor.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const defaultPageState = {
  elements: [
    { index: 0, rect: { x: 100, y: 100, w: 200, h: 40 }, inViewport: true,  text: '', attrs: {} },
    { index: 1, rect: { x: 100, y: 900, w: 200, h: 40 }, inViewport: false, text: '', attrs: {} },
  ],
  context: { screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 720 },
  viewportWidth: 1280,
  viewportHeight: 720,
  scrollX: 0,
  scrollY: 0,
};

// scrolledState: element 1 is now in-viewport after a scroll
const scrolledState = {
  ...defaultPageState,
  elements: [
    { index: 0, rect: { x: 100, y: 100, w: 200, h: 40 }, inViewport: true, text: '', attrs: {} },
    { index: 1, rect: { x: 100, y: 400, w: 200, h: 40 }, inViewport: true, text: '', attrs: {} },
  ],
};

// ── mock setup ─────────────────────────────────────────────────────────────────

let mockBridge;
let mockInputControl;

beforeEach(() => {
  mockBridge = {
    navigate:           jest.fn().mockResolvedValue(undefined),
    waitForPageSettle:  jest.fn().mockResolvedValue(undefined),
    getActiveTabId:     jest.fn().mockResolvedValue(1),
    getPageState:       jest.fn().mockResolvedValue(defaultPageState),
    scrollToPosition:         jest.fn().mockResolvedValue(undefined),
    scrollElementIntoView:    jest.fn().mockResolvedValue(true),
    focusElement:             jest.fn().mockResolvedValue(true),
    getElementValue:          jest.fn().mockResolvedValue('hello'), // default: matches typed text
  };
  mockInputControl = { execute: jest.fn().mockResolvedValue(undefined) };

  jest.spyOn(ActionExecutor.prototype, '_sleep').mockResolvedValue(undefined);
  jest.spyOn(ActionExecutor.prototype, '_rand').mockReturnValue(0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeExecutor() {
  return new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
}

function inputCalls() {
  return mockInputControl.execute.mock.calls;
}

function inputCommandSequence() {
  return inputCalls().map(c => c[0]);
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('ActionExecutor v2', () => {
  // 1. click produces mouse_move then mouse_click
  test('test_click_action_calls_mouse_move_then_click', async () => {
    const executor = makeExecutor();
    await executor.execute({ click: { index: 0 } }, defaultPageState);
    const commands = inputCommandSequence();
    expect(commands).toContain('mouse_move');
    expect(commands).toContain('mouse_click');
    expect(commands.indexOf('mouse_move')).toBeLessThan(commands.indexOf('mouse_click'));
  });

  // 2. out-of-viewport element calls bridge.scrollElementIntoView (not a wheel event)
  test('test_click_out_of_viewport_uses_scrollToPosition', async () => {
    mockBridge.getPageState.mockResolvedValue(scrolledState);
    const executor = makeExecutor();
    await executor.execute({ click: { index: 1 } }, defaultPageState);
    expect(mockBridge.scrollElementIntoView).toHaveBeenCalledWith(
      1,                    // tabId
      expect.any(Number),  // element index
    );
    // mouse_move and mouse_click must follow the scroll
    const commands = inputCommandSequence();
    expect(commands).toContain('mouse_move');
    expect(commands).toContain('mouse_click');
  });

  // 3. out-of-viewport element causes bridge.getPageState to be called (re-fetch)
  test('test_click_out_of_viewport_refetches_page_state', async () => {
    mockBridge.getPageState.mockResolvedValue(scrolledState);
    const executor = makeExecutor();
    await executor.execute({ click: { index: 1 } }, defaultPageState);
    expect(mockBridge.getPageState).toHaveBeenCalled();
  });

  // 2b. scrollElementIntoView is called with the correct tabId and element index
  test('test_scrollElementIntoView_called_with_index', async () => {
    mockBridge.getPageState.mockResolvedValue(scrolledState);
    const executor = makeExecutor();
    await executor.execute({ click: { index: 1 } }, defaultPageState);
    expect(mockBridge.scrollElementIntoView).toHaveBeenCalledWith(1, 1); // tabId=1, elIndex=1
  });

  // 2c. falls back to scrollToPosition when scrollElementIntoView returns false
  test('test_fallback_to_scrollToPosition_when_scrollElementIntoView_fails', async () => {
    mockBridge.scrollElementIntoView.mockResolvedValue(false); // simulate content script miss
    mockBridge.getPageState.mockResolvedValue(scrolledState);
    const executor = makeExecutor();
    await executor.execute({ click: { index: 1 } }, defaultPageState);
    expect(mockBridge.scrollToPosition).toHaveBeenCalled();
    // el index 1: rect.y=900, rect.h=40, scrollY=0 → absY=920 → targetScrollY=920-360=560
    const [, , targetScrollY] = mockBridge.scrollToPosition.mock.calls[0];
    expect(targetScrollY).toBe(560);
  });

  // 2c. element still out of viewport after max attempts → throws ExecutorError
  test('test_coords_outside_viewport_throws_after_max_attempts', async () => {
    // getPageState always returns element 1 as out-of-viewport
    mockBridge.getPageState.mockResolvedValue(defaultPageState);
    const executor = makeExecutor();
    await expect(executor.execute({ click: { index: 1 } }, defaultPageState))
      .rejects.toThrow(ExecutorError);
    // scrollElementIntoView should have been attempted MAX_SCROLL_ATTEMPTS (3) times
    expect(mockBridge.scrollElementIntoView).toHaveBeenCalledTimes(3);
  });

  // unknown index — re-fetches page state once before throwing
  test('test_unknown_index_refetches_before_throwing', async () => {
    const executor = makeExecutor();
    // index 99 does not exist; getPageState still returns defaultPageState (no index 99)
    await expect(executor.execute({ click: { index: 99 } }, defaultPageState))
      .rejects.toThrow(ExecutorError);
    // Must have re-fetched
    expect(mockBridge.getPageState).toHaveBeenCalled();
  });

  // unknown index — succeeds after re-fetch provides the element
  test('test_unknown_index_succeeds_after_refetch', async () => {
    const executor = makeExecutor();
    // Simulate: original pageState has no index 5; re-fetch provides it in-viewport
    const stateWithIndex5 = {
      ...defaultPageState,
      elements: [
        ...defaultPageState.elements,
        { index: 5, rect: { x: 200, y: 200, w: 100, h: 30 }, inViewport: true, text: '', attrs: {} },
      ],
    };
    mockBridge.getPageState.mockResolvedValue(stateWithIndex5);
    await executor.execute({ click: { index: 5 } }, defaultPageState); // no index 5 in original
    const commands = inputCommandSequence();
    expect(commands).toContain('mouse_move');
    expect(commands).toContain('mouse_click');
  });

  // 4. navigate calls bridge.navigate and waitForPageSettle
  test('test_navigate_calls_bridge', async () => {
    const executor = makeExecutor();
    await executor.execute({ navigate: { url: 'https://x.com' } }, defaultPageState);
    expect(mockBridge.navigate).toHaveBeenCalledWith('https://x.com');
    expect(mockBridge.waitForPageSettle).toHaveBeenCalled();
    expect(mockInputControl.execute).not.toHaveBeenCalled();
  });

  // 5. type produces: mouse_move, mouse_click, press_shortcut (ctrl+a), press_key (Delete), type
  test('test_type_calls_select_all_then_delete_then_type', async () => {
    const executor = makeExecutor();
    await executor.execute({ type: { index: 0, text: 'hello' } }, defaultPageState);
    const commands = inputCommandSequence();
    expect(commands[0]).toBe('mouse_move');
    expect(commands[1]).toBe('mouse_click');
    expect(commands[2]).toBe('press_shortcut');
    expect(commands[3]).toBe('press_key');
    expect(commands[4]).toBe('type');

    // verify shortcut keys
    const shortcutCall = inputCalls().find(c => c[0] === 'press_shortcut');
    expect(shortcutCall[1].keys).toEqual(['control', 'a']);

    // verify delete key
    const deleteCall = inputCalls().find(c => c[0] === 'press_key');
    expect(deleteCall[1].key).toBe('Delete');

    // verify typed text
    const typeCall = inputCalls().find(c => c[0] === 'type');
    expect(typeCall[1].text).toBe('hello');
  });

  // 6. scroll down medium → delta_y: 500
  test('test_scroll_down_medium_calls_scroll', async () => {
    const executor = makeExecutor();
    await executor.execute({ scroll: { direction: 'down', amount: 'medium' } }, defaultPageState);
    const commands = inputCommandSequence();
    expect(commands).toContain('scroll');
    const scrollCall = inputCalls().find(c => c[0] === 'scroll');
    expect(scrollCall[1].delta_y).toBe(500);
  });

  // 7. scroll up small → delta_y: -200
  test('test_scroll_up_calls_negative_delta', async () => {
    const executor = makeExecutor();
    await executor.execute({ scroll: { direction: 'up', amount: 'small' } }, defaultPageState);
    const scrollCall = inputCalls().find(c => c[0] === 'scroll');
    expect(scrollCall[1].delta_y).toBe(-200);
  });

  // 8. wait sleeps for the specified milliseconds
  test('test_wait_sleeps', async () => {
    const sleepSpy = jest.spyOn(ActionExecutor.prototype, '_sleep').mockResolvedValue(undefined);
    const executor = makeExecutor();
    await executor.execute({ wait: { seconds: 2 } }, defaultPageState);
    expect(sleepSpy).toHaveBeenCalledWith(2000);
  });

  // 9. done returns the result object without touching inputControl
  test('test_done_returns_result_object', async () => {
    const executor = makeExecutor();
    const result = await executor.execute({ done: { success: true, message: 'ok' } }, defaultPageState);
    expect(result).toEqual({ done: true, success: true, message: 'ok' });
    expect(mockInputControl.execute).not.toHaveBeenCalled();
  });

  // _executeType: focusElement is called between click and Ctrl+A
  test('test_type_calls_focusElement_before_shortcut', async () => {
    mockBridge.getElementValue.mockResolvedValue('hello');
    const executor = makeExecutor();
    await executor.execute({ type: { index: 0, text: 'hello' } }, defaultPageState);
    // focusElement must be called
    expect(mockBridge.focusElement).toHaveBeenCalledWith(1, 0);
    // and it must happen before the Ctrl+A shortcut
    const focusOrder   = mockBridge.focusElement.mock.invocationCallOrder[0];
    const shortcutCall = mockInputControl.execute.mock.calls.findIndex(c => c[0] === 'press_shortcut');
    const shortcutOrder= mockInputControl.execute.mock.invocationCallOrder[shortcutCall];
    expect(focusOrder).toBeLessThan(shortcutOrder);
  });

  // _executeType: success on first attempt when value matches
  test('test_type_succeeds_when_value_matches', async () => {
    mockBridge.getElementValue.mockResolvedValue('hello');
    const executor = makeExecutor();
    await expect(executor.execute({ type: { index: 0, text: 'hello' } }, defaultPageState))
      .resolves.not.toThrow();
    // Only one call to 'type' (no retry)
    const typeCalls = mockInputControl.execute.mock.calls.filter(c => c[0] === 'type');
    expect(typeCalls).toHaveLength(1);
  });

  // _executeType: retries once when first attempt value is empty
  test('test_type_retries_when_value_empty', async () => {
    // First verification returns empty, second returns correct value
    mockBridge.getElementValue
      .mockResolvedValueOnce('')
      .mockResolvedValue('hello');
    const executor = makeExecutor();
    await expect(executor.execute({ type: { index: 0, text: 'hello' } }, defaultPageState))
      .resolves.not.toThrow();
    // Two 'type' calls (original + retry)
    const typeCalls = mockInputControl.execute.mock.calls.filter(c => c[0] === 'type');
    expect(typeCalls).toHaveLength(2);
  });

  // _executeType: throws ExecutorError after all attempts fail
  test('test_type_throws_after_all_attempts_fail', async () => {
    mockBridge.getElementValue.mockResolvedValue(''); // always empty
    const executor = makeExecutor();
    await expect(executor.execute({ type: { index: 0, text: 'hello' } }, defaultPageState))
      .rejects.toThrow(ExecutorError);
  });

  // _typeSucceeded: null value is treated as success (unreadable rich-text editor)
  test('test_typeSucceeded_null_is_success', () => {
    const executor = makeExecutor();
    expect(executor._typeSucceeded(null, 'anything')).toBe(true);
  });

  // _typeSucceeded: exact match
  test('test_typeSucceeded_exact_match', () => {
    const executor = makeExecutor();
    expect(executor._typeSucceeded('hello', 'hello')).toBe(true);
  });

  // _typeSucceeded: empty actual is failure
  test('test_typeSucceeded_empty_is_failure', () => {
    const executor = makeExecutor();
    expect(executor._typeSucceeded('', 'hello')).toBe(false);
  });

  // _typeSucceeded: long text partial match (first 50 chars match, >=80% length)
  test('test_typeSucceeded_partial_long_text', () => {
    const executor = makeExecutor();
    const expected = 'A'.repeat(200);
    const actual   = 'A'.repeat(170); // 85% ≥ 80%
    expect(executor._typeSucceeded(actual, expected)).toBe(true);
  });

  // 10. unknown action name throws ExecutorError
  test('test_unknown_action_throws', async () => {
    const executor = makeExecutor();
    await expect(executor.execute({ foobar: {} }, defaultPageState))
      .rejects.toThrow(ExecutorError);
  });

  // 11. action object with multiple keys throws ExecutorError
  test('test_multiple_keys_in_action_throws', async () => {
    const executor = makeExecutor();
    await expect(executor.execute({ click: { index: 0 }, scroll: {} }, defaultPageState))
      .rejects.toThrow(ExecutorError);
  });

  // 12. every inputControl.execute call receives pageState.context as the 3rd argument
  test('test_context_passed_to_every_inputcontrol_call', async () => {
    const executor = makeExecutor();
    await executor.execute({ click: { index: 0 } }, defaultPageState);
    for (const call of inputCalls()) {
      expect(call[2]).toEqual(defaultPageState.context);
    }
  });
});
