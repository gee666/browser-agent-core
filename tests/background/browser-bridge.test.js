import { jest } from '@jest/globals';
import { BrowserBridge, BridgeError } from '../../background/browser-bridge.js';

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset chrome.* mocks between tests so each test starts clean.
  chrome.runtime.lastError = undefined;
  chrome.tabs.sendMessage = jest.fn();
  chrome.scripting.executeScript = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('BrowserBridge', () => {
  // ── extractorPath ─────────────────────────────────────────────────────────

  test('test_default_extractor_path', () => {
    const bridge = new BrowserBridge();
    expect(bridge._extractorPath).toBe('lib/browser-agent-core/content/extractor.js');
  });

  test('test_extractor_path_override', () => {
    const bridge = new BrowserBridge({ extractorPath: 'custom/dist/extractor.bundle.js' });
    expect(bridge._extractorPath).toBe('custom/dist/extractor.bundle.js');
  });

  // ── _isReceivingEndMissingError ───────────────────────────────────────────

  test('test_isReceivingEndMissingError_true_for_chrome_message', () => {
    const err = new Error('Could not establish connection. Receiving end does not exist.');
    expect(BrowserBridge._isReceivingEndMissingError(err)).toBe(true);
  });

  test('test_isReceivingEndMissingError_true_case_insensitive', () => {
    const err = new Error('RECEIVING END DOES NOT EXIST');
    expect(BrowserBridge._isReceivingEndMissingError(err)).toBe(true);
  });

  test('test_isReceivingEndMissingError_false_for_permission_error', () => {
    const err = new Error('Cannot access contents of the page. Extension manifest must request permission to access this host.');
    expect(BrowserBridge._isReceivingEndMissingError(err)).toBe(false);
  });

  test('test_isReceivingEndMissingError_false_for_timeout', () => {
    const err = new Error('getPageState timed out');
    expect(BrowserBridge._isReceivingEndMissingError(err)).toBe(false);
  });

  test('test_isReceivingEndMissingError_false_for_null', () => {
    expect(BrowserBridge._isReceivingEndMissingError(null)).toBe(false);
    expect(BrowserBridge._isReceivingEndMissingError(undefined)).toBe(false);
    expect(BrowserBridge._isReceivingEndMissingError({})).toBe(false);
  });

  // ── getPageState: permission error path (no reinject) ─────────────────────

  test('test_getPageState_does_not_reinject_on_permission_error', async () => {
    chrome.tabs.sendMessage.mockImplementation((tabId, msg, cb) => {
      chrome.runtime.lastError = { message: 'Cannot access contents of the page.' };
      cb(undefined);
      chrome.runtime.lastError = undefined;
    });

    const bridge = new BrowserBridge();
    await expect(bridge.getPageState(1)).rejects.toThrow(BridgeError);
    await expect(bridge.getPageState(1)).rejects.toThrow(/Cannot access contents/);

    // Crucially: no reinject attempt was made.
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('test_getPageState_does_not_reinject_on_timeout', async () => {
    jest.useFakeTimers();

    // sendMessage never calls the callback -> triggers the 10s timeout.
    chrome.tabs.sendMessage.mockImplementation(() => {});

    const bridge = new BrowserBridge();
    const promise = bridge.getPageState(1);
    // Attach a catch handler immediately so Node does not flag an unhandled
    // rejection before we advance the timers.
    const settled = promise.catch((err) => err);

    jest.advanceTimersByTime(10_001);
    const result = await settled;
    expect(result).toBeInstanceOf(BridgeError);
    expect(result.message).toMatch(/timed out/);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  // ── getPageState: reinject path ───────────────────────────────────────────

  test('test_getPageState_reinjects_on_receiving_end_missing_and_retries', async () => {
    let sendCalls = 0;
    chrome.tabs.sendMessage.mockImplementation((tabId, msg, cb) => {
      sendCalls++;
      if (sendCalls === 1) {
        chrome.runtime.lastError = {
          message: 'Could not establish connection. Receiving end does not exist.',
        };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      } else {
        // Second attempt after reinjection succeeds.
        cb({ url: 'https://example.com', elements: [] });
      }
    });

    chrome.scripting.executeScript.mockImplementation((opts, cb) => {
      // No error; simulate successful injection.
      cb();
    });

    const bridge = new BrowserBridge({ extractorPath: 'custom/extractor.js' });
    const state = await bridge.getPageState(42);

    expect(state).toEqual({ url: 'https://example.com', elements: [] });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    const [opts] = chrome.scripting.executeScript.mock.calls[0];
    expect(opts.target).toEqual({ tabId: 42 });
    expect(opts.files).toEqual(['custom/extractor.js']);
    expect(sendCalls).toBe(2);
  });

  test('test_getPageState_propagates_reinject_error', async () => {
    chrome.tabs.sendMessage.mockImplementation((tabId, msg, cb) => {
      chrome.runtime.lastError = {
        message: 'Could not establish connection. Receiving end does not exist.',
      };
      cb(undefined);
      chrome.runtime.lastError = undefined;
    });

    chrome.scripting.executeScript.mockImplementation((opts, cb) => {
      chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
      cb();
      chrome.runtime.lastError = undefined;
    });

    const bridge = new BrowserBridge();
    await expect(bridge.getPageState(1)).rejects.toThrow(/chrome:\/\//);
  });
});
