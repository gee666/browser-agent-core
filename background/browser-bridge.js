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

/**
 * BrowserBridge — Chrome-extension-side transport used by AgentCore and
 * ActionExecutor.
 *
 * Required capabilities (always implemented):
 *   - getActiveTabId(): Promise<number>
 *   - getPageState(tabId): Promise<object>
 *   - takeScreenshot(): Promise<string|null>
 *   - navigate(url, timeoutMs?): Promise<void>
 *   - waitForPageSettle(tabId?, ms?): Promise<void>
 *   - getElementValue(tabId, index): Promise<string|null>
 *   - sendStatus(status): void
 *
 * Optional DOM-assistance capabilities (ActionExecutor feature-detects them):
 *   - focusElement(tabId, index): Promise<boolean>
 *       Native content-script DOM focus() to reliably target an element
 *       before issuing a keyboard shortcut.
 *   - scrollElementIntoView(tabId, index): Promise<boolean>
 *       Native content-script scrollIntoView(). Return false to signal the
 *       executor should fall back to scrollToPosition or a wheel scroll.
 *   - scrollToPosition(tabId, x, y): Promise<void>
 *       Native window.scrollTo() fallback used when scrollElementIntoView()
 *       cannot reach the target.
 *
 * Embedders may subclass BrowserBridge or provide a duck-typed replacement
 * that implements the required capabilities. See AGENTS.md — all user input
 * (click/type/scroll/keys) MUST flow through python-input-control, not
 * synthetic browser events.
 *
 * Constructor options:
 *   extractorPath: string — extension-relative path of the content extractor
 *                          bundle. Defaults to the stock layout used by the
 *                          official extension; override for custom builds.
 */
export class BrowserBridge {
  constructor({ extractorPath = 'lib/browser-agent-core/content/extractor.js' } = {}) {
    this._extractorPath = extractorPath;
  }

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
    } catch (firstError) {
      // Only attempt reinjection when the failure is specifically "content
      // script not present" (Chrome's wording: "receiving end does not exist").
      // Other failures — timeouts, restricted pages, permission errors — are
      // NOT solved by reinjecting, so surface them unchanged instead of
      // masking the real cause.
      if (!BrowserBridge._isReceivingEndMissingError(firstError)) {
        throw firstError;
      }
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          { target: { tabId }, files: [this._extractorPath] },
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

  /**
   * Returns true when the error message indicates the content script is not
   * loaded in the target tab and reinjection is a valid recovery.
   * Chrome reports this as "Could not establish connection. Receiving end does
   * not exist." — match it case-insensitively and conservatively.
   */
  static _isReceivingEndMissingError(err) {
    const msg = (err && err.message) ? String(err.message).toLowerCase() : '';
    if (!msg) return false;
    return (
      msg.includes('receiving end does not exist') ||
      msg.includes('could not establish connection')
    );
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
