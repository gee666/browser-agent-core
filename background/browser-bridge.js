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

    await new Promise((resolve, reject) => {
      chrome.tabs.update(activeTabId, { url }, (updatedTab) => {
        if (chrome.runtime.lastError) {
          return reject(new BridgeError(chrome.runtime.lastError.message));
        }
        resolve(updatedTab);
      });
    });

    const tabId = activeTabId;

    await new Promise((resolve, reject) => {
      let timer;

      const listener = (details) => {
        if (details.tabId !== tabId || details.frameId !== 0) return;
        clearTimeout(timer);
        chrome.webNavigation.onCompleted.removeListener(listener);
        resolve();
      };

      timer = setTimeout(() => {
        chrome.webNavigation.onCompleted.removeListener(listener);
        reject(new NavigationTimeoutError());
      }, timeoutMs);

      chrome.webNavigation.onCompleted.addListener(listener);
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
   * Scroll the element with the given extractor index into the viewport by calling
   * element.scrollIntoView() on the real DOM node inside the content script.
   *
   * This is the most reliable scroll method: it works with nested scroll containers,
   * fixed/sticky ancestors, and pages that override window.scrollTo.
   *
   * @param {number} tabId
   * @param {number} index  - extractor element index
   * @returns {Promise<boolean>} true if the element was found and scrolled
   */
  async scrollElementIntoView(tabId, index) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      chrome.tabs.sendMessage(tabId, { type: 'scroll_to_index', index }, (response) => {
        clearTimeout(timer);
        void chrome.runtime.lastError; // suppress unchecked error
        resolve(response?.ok === true);
      });
    });
  }

  /**
   * Scroll the tab to an absolute page position using window.scrollTo (pixel-perfect).
   * This is used by the executor to bring elements into the viewport before clicking.
   * Unlike native wheel events, this scrolls the exact number of pixels requested.
   * @param {number} tabId
   * @param {number} scrollX  - target window.scrollX
   * @param {number} scrollY  - target window.scrollY
   */
  async scrollToPosition(tabId, scrollX, scrollY) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: (sx, sy) => window.scrollTo({ left: sx, top: sy, behavior: 'instant' }),
          args: [Math.max(0, Math.round(scrollX)), Math.max(0, Math.round(scrollY))],
        },
        () => {
          if (chrome.runtime.lastError) {
            return reject(new BridgeError(chrome.runtime.lastError.message));
          }
          resolve();
        },
      );
    });
  }

  sendStatus(status) {
    chrome.storage.local.set({ agentStatus: status });

    chrome.runtime.sendMessage({ type: 'agent_status', status }).catch(() => {
      // Ignore — no listeners present
    });
  }
}
