import { jest } from '@jest/globals';
import { InputControlBridge, InputControlError, InputControlTimeoutError } from '../../background/input-control.js';

// ── mock factory ──────────────────────────────────────────────────────────────

function createMockPort() {
  const listeners = { message: [], disconnect: [] };
  return {
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    /** Emit an event to all registered listeners for that event. */
    _emit: (event, data) => listeners[event].forEach((fn) => fn(data)),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('InputControlBridge', () => {
  test('test_connect_opens_native_port', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    const bridge = new InputControlBridge();
    await bridge.connect();

    expect(chrome.runtime.connectNative).toHaveBeenCalledWith('com.workshop.python_input_control');
  });

  test('test_execute_sends_correct_message', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    const bridge = new InputControlBridge();
    // Don't await — we'll resolve it manually.
    const promise = bridge.execute('mouse_click', { x: 100, y: 100 }, {});

    // Allow the async connect + postMessage to run.
    await Promise.resolve();

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        command: 'mouse_click',
        params: { x: 100, y: 100 },
        context: {},
      }),
    );

    // Resolve the pending promise to avoid leaking.
    const sentId = port.postMessage.mock.calls[0][0].id;
    port._emit('message', { id: sentId, status: 'ok' });
    await promise;
  });

  test('test_execute_resolves_on_ok_response', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    const bridge = new InputControlBridge();
    const promise = bridge.execute('mouse_click', { x: 100, y: 100 }, {});

    await Promise.resolve();

    const sentId = port.postMessage.mock.calls[0][0].id;
    port._emit('message', { id: sentId, status: 'ok' });

    await expect(promise).resolves.toBeDefined();
  });

  test('test_execute_rejects_on_error_response', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    const bridge = new InputControlBridge();
    const promise = bridge.execute('mouse_click', { x: 100, y: 100 }, {});

    await Promise.resolve();

    const sentId = port.postMessage.mock.calls[0][0].id;
    port._emit('message', { id: sentId, status: 'error', error: 'oob' });

    await expect(promise).rejects.toThrow('oob');
  });

  test('test_execute_rejects_on_disconnect', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    // chrome.runtime.lastError must not throw when accessed.
    Object.defineProperty(chrome.runtime, 'lastError', {
      get: () => undefined,
      configurable: true,
    });

    const bridge = new InputControlBridge();
    const promise = bridge.execute('mouse_click', { x: 100, y: 100 }, {});

    await Promise.resolve();

    // Disconnect before responding — pending promise should reject.
    port._emit('disconnect', null);

    await expect(promise).rejects.toThrow(InputControlError);
  });

  test('test_concurrent_requests_matched_by_id', async () => {
    const port = createMockPort();
    chrome.runtime.connectNative.mockReturnValue(port);

    const bridge = new InputControlBridge();

    const p1 = bridge.execute('cmd1', { a: 1 }, {});
    // Allow connect + first postMessage.
    await Promise.resolve();

    const p2 = bridge.execute('cmd2', { b: 2 }, {});
    // Allow second postMessage.
    await Promise.resolve();

    expect(port.postMessage).toHaveBeenCalledTimes(2);

    const id1 = port.postMessage.mock.calls[0][0].id;
    const id2 = port.postMessage.mock.calls[1][0].id;
    expect(id1).not.toBe(id2);

    // Respond in reverse order — each promise should still resolve correctly.
    port._emit('message', { id: id2, status: 'ok' });
    port._emit('message', { id: id1, status: 'ok' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
  });
});
