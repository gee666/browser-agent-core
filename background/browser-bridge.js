export class BridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class NavigationTimeoutError extends Error {
  constructor() {
    super('Navigation timed out');
    this.name = 'NavigationTimeoutError';
  }
}

export class BrowserBridge {
  async getActiveTabId() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          return reject(new BridgeError(chrome.runtime.lastError.message));
        }
        if (!tabs || tabs.length === 0) {
          return reject(new BridgeError('No active tab found'));
        }
        resolve(tabs[0].id);
      });
    });
  }

  async getPageState(tabId) {
    const sendMessage = (id) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new BridgeError('getPageState timed out'));
        }, 10_000);

        chrome.tabs.sendMessage(id, { type: 'get_page_state' }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            return reject(new BridgeError(chrome.runtime.lastError.message));
          }
          resolve(response);
        });
      });

    try {
      return await sendMessage(tabId);
    } catch (_firstError) {
      // Content script not injected — inject and retry once
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['lib/browser-agent-core/content/extractor.js'] },
          () => {
            if (chrome.runtime.lastError) {
              return reject(new BridgeError(chrome.runtime.lastError.message));
            }
            resolve();
          }
        );
      });

      return await sendMessage(tabId);
    }
  }

  async takeScreenshot() {
    return new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          return resolve(null);
        }
        resolve(dataUrl);
      });
    });
  }

  async navigate(url, timeoutMs = 30_000) {
    // Get active tab id first so we have it for the navigation listener
    const activeTabId = await this.getActiveTabId();

    // Register the onCompleted listener BEFORE initiating navigation to avoid
    // a race condition where fast/cached pages fire the event before the
    // listener is attached, causing the promise to never resolve (timeout).
    await new Promise((resolve, reject) => {
      let timer;

      const listener = (details) => {
        if (details.tabId !== activeTabId || details.frameId !== 0) return;
        clearTimeout(timer);
        chrome.webNavigation.onCompleted.removeListener(listener);
        resolve();
      };

      timer = setTimeout(() => {
        chrome.webNavigation.onCompleted.removeListener(listener);
        reject(new NavigationTimeoutError());
      }, timeoutMs);

      chrome.webNavigation.onCompleted.addListener(listener);

      // Start navigation only after the listener is in place
      chrome.tabs.update(activeTabId, { url }, () => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          chrome.webNavigation.onCompleted.removeListener(listener);
          reject(new BridgeError(chrome.runtime.lastError.message));
        }
      });
    });

    // Additional settle delay
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  async waitForPageSettle(tabId, ms = 3000) {
    // If no tabId provided, fall back to active tab
    if (tabId == null) {
      tabId = await this.getActiveTabId().catch(() => null);
    }
    if (tabId == null) {
      // Nothing we can do — just wait the fallback delay
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), ms);

      chrome.tabs.sendMessage(tabId, { type: 'wait_for_settle' }, () => {
        clearTimeout(timer);
        // Ignore chrome.runtime.lastError — non-fatal
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  /**
   * Read back the current value of an element via the content script.
   * For inputs/textareas returns .value; for contenteditable returns .textContent.
   * Returns null if the element cannot be found or the message times out.
   * @param {number} tabId
   * @param {number} index
   * @returns {Promise<string|null>}
   */
  async getElementValue(tabId, index) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      chrome.tabs.sendMessage(tabId, { type: 'get_element_value', index }, (response) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        resolve(response?.ok ? (response.value ?? '') : null);
      });
    });
  }

  sendStatus(status) {
    chrome.storage.local.set({ agentStatus: status });

    chrome.runtime.sendMessage({ type: 'agent_status', status }).catch(() => {
      // Ignore — no listeners present
    });
  }
}
