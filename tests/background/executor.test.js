import { jest } from '@jest/globals';
import { ActionExecutor } from '../../background/executor.js';

// ── mocks ─────────────────────────────────────────────────────────────────────

let mockBridge;
let mockInputControl;

const defaultPageState = {
  elements: [
    { id: 'el_0', rect: { x: 100, y: 100, width: 200, height: 40 }, inViewport: true },
    { id: 'el_1', rect: { x: 100, y: 900, width: 200, height: 40 }, inViewport: false },
  ],
  context: { screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 720 },
  viewportWidth: 1280,
  viewportHeight: 720,
};

beforeEach(() => {
  mockBridge = {
    navigate: jest.fn().mockResolvedValue(undefined),
    waitForPageSettle: jest.fn().mockResolvedValue(undefined),
  };
  mockInputControl = {
    execute: jest.fn().mockResolvedValue(undefined),
  };

  // Suppress the random sleeps so tests run instantly.
  jest.spyOn(ActionExecutor.prototype, '_sleep').mockResolvedValue(undefined);
  jest.spyOn(ActionExecutor.prototype, '_randomMs').mockReturnValue(400);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ActionExecutor', () => {
  test('test_navigate_action_calls_bridge', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    await executor.execute(
      [{ command: 'navigate', params: { url: 'https://x.com' } }],
      defaultPageState,
    );
    expect(mockBridge.navigate).toHaveBeenCalledWith('https://x.com');
    expect(mockInputControl.execute).not.toHaveBeenCalled();
  });

  test('test_auto_mouse_move_before_click', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    // el_0 centre is at (200, 120) — inViewport, so no scroll.
    await executor.execute(
      [{ command: 'mouse_click', params: { x: 200, y: 120 } }],
      defaultPageState,
    );

    const commands = mockInputControl.execute.mock.calls.map((c) => c[0]);
    expect(commands[0]).toBe('mouse_move');
    expect(commands[1]).toBe('mouse_click');
  });

  test('test_no_duplicate_move_when_move_already_present', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    await executor.execute(
      [
        { command: 'mouse_move', params: { x: 200, y: 120, duration_ms: 400 } },
        { command: 'mouse_click', params: { x: 200, y: 120 } },
      ],
      defaultPageState,
    );

    const commands = mockInputControl.execute.mock.calls.map((c) => c[0]);
    const moveCalls = commands.filter((c) => c === 'mouse_move');
    expect(moveCalls).toHaveLength(1);
  });

  test('test_scroll_prepended_for_out_of_viewport', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    // el_1 centre is at (200, 920) — inViewport: false.
    await executor.execute(
      [{ command: 'mouse_click', params: { x: 200, y: 920 } }],
      defaultPageState,
    );

    const commands = mockInputControl.execute.mock.calls.map((c) => c[0]);
    expect(commands[0]).toBe('scroll');
  });

  test('test_no_scroll_for_in_viewport_element', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    // el_0 centre is at (200, 120) — inViewport: true.
    await executor.execute(
      [{ command: 'mouse_click', params: { x: 200, y: 120 } }],
      defaultPageState,
    );

    const commands = mockInputControl.execute.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain('scroll');
  });

  test('test_context_injected_into_execute_call', async () => {
    const executor = new ActionExecutor({ bridge: mockBridge, inputControl: mockInputControl });
    await executor.execute(
      [{ command: 'mouse_move', params: { x: 200, y: 120, duration_ms: 400 } }],
      defaultPageState,
    );

    // Third argument of every inputControl.execute call should match defaultPageState.context.
    for (const callArgs of mockInputControl.execute.mock.calls) {
      expect(callArgs[2]).toEqual(defaultPageState.context);
    }
  });
});
