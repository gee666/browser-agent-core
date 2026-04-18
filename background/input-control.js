export class InputControlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputControlError';
  }
}

export class InputControlTimeoutError extends Error {
  constructor() {
    super('Input control command timed out');
    this.name = 'InputControlTimeoutError';
  }
}

export class InputControlBridge {
  constructor() {
    this._port = null;
    this._pending = new Map(); // id → { resolve, reject, timer }
  }

  async connect() {
    this._port = chrome.runtime.connectNative('com.workshop.python_input_control');

    this._port.onMessage.addListener((message) => {
      const entry = this._pending.get(message.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      this._pending.delete(message.id);

      if (message.status === 'error') {
        entry.reject(new InputControlError(message.error));
      } else {
        entry.resolve(message);
      }
    });

    this._port.onDisconnect.addListener(() => {
      this._port = null;
      const error = new InputControlError(
        chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : 'Native host disconnected'
      );
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this._pending.clear();
    });
  }

  /**
   * Estimate a reasonable timeout for a command.
   * For 'type', derive it from text length + WPM so long prompts never time out.
   * Everything else gets a flat 30 s.
   */
  _timeoutFor(command, params) {
    if (command === 'type' && typeof params?.text === 'string') {
      const wpm = params.wpm || 60;
      const chars = params.text.length;
      // ms to type the text at the given WPM (1 word ≈ 5 chars)
      const typingMs = Math.ceil((chars / (wpm * 5)) * 60_000);
      // add 10 s headroom for startup / inter-key jitter
      return Math.max(30_000, typingMs + 10_000);
    }
    return 30_000;
  }

  async execute(command, params, context) {
    if (!this._port) {
      await this.connect();
    }

    const id = crypto.randomUUID();
    const timeoutMs = this._timeoutFor(command, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new InputControlTimeoutError());
        }
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      this._port.postMessage({ id, command, params, context });
    });
  }

  disconnect() {
    if (this._port) {
      this._port.disconnect();
      this._port = null;
    }
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new InputControlError('Disconnected'));
    }
    this._pending.clear();
  }

  /**
   * Immediately abort any in-flight command and stop the native host.
   *
   * 1. Rejects all pending promises right away so awaiting JS code unblocks.
   * 2. Disconnects the port — Chrome closes Python's stdin, which triggers
   *    the EOF path in serve_forever() and sets the cancel_event so the
   *    Python typing/mouse loop stops within one inter-key delay (~50-100 ms).
   *
   * After abort() the bridge is fully reset; the next execute() call will
   * reconnect to a fresh native host process.
   */
  abort() {
    // Step 1: reject all pending promises immediately
    const abortError = new InputControlError('Aborted: stop was requested');
    abortError.name = 'InputControlAbortError';
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(abortError);
    }
    this._pending.clear();

    // Step 2: disconnect port → sends EOF to Python → cancels the in-flight op
    if (this._port) {
      this._port.disconnect();
      this._port = null;
    }
  }
}
