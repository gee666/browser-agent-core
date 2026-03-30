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

  async execute(command, params, context) {
    if (!this._port) {
      await this.connect();
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new InputControlTimeoutError());
        }
      }, 30_000);

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
}
