import { parseJSONFromText, LLMParseError } from './llm/utils.js';

/**
 * AgentCore orchestrates the LLM reasoning loop for browser automation.
 */
export class AgentCore {
  /**
   * @param {object} options
   * @param {object} options.bridge       - BrowserBridge instance
   * @param {object} options.executor     - ActionExecutor instance
   * @param {object} options.llm          - LLMProvider instance
   * @param {number} [options.maxIterations=20]
   * @param {boolean} [options.useVision=false]
   * @param {function} [options.onStatus] - Called with {state, ...} on each state change
   */
  constructor({
    bridge,
    executor,
    llm,
    maxIterations = 20,
    useVision = false,
    onStatus = () => {},
  }) {
    this._bridge = bridge;
    this._executor = executor;
    this._llm = llm;
    this._maxIterations = maxIterations;
    this._useVision = useVision;
    this._onStatus = onStatus;
    this._stopped = false;
  }

  /** Signal the running loop to stop after the current iteration. */
  stop() {
    this._stopped = true;
  }

  /**
   * Run the agent loop for the given task.
   * @param {string} task
   * @returns {Promise<string|null>} The done message from the LLM, or null.
   */
  async run(task) {
    this._stopped = false;
    this._onStatus({ state: 'running' });

    // If the task contains a URL, navigate there first.
    const urlMatch = /https?:\/\/[^\s]+/.exec(task);
    if (urlMatch) {
      await this._bridge.navigate(urlMatch[0]);
      await this._bridge.waitForPageSettle();
    }

    const system =
      'You are a browser automation agent. ' +
      'Respond with JSON: {"done": boolean, "message": string (when done), "actions": array (when not done)}';

    const messages = [{ role: 'user', content: task }];

    for (let iteration = 0; iteration < this._maxIterations; iteration++) {
      if (this._stopped) {
        this._onStatus({ state: 'stopped' });
        return null;
      }

      const tabId = await this._bridge.getActiveTabId();
      const pageState = await this._bridge.getPageState(tabId);

      let screenshot = null;
      if (this._useVision) {
        screenshot = await this._bridge.takeScreenshot();
      }

      this._onStatus({ state: 'thinking' });

      // Call LLM, with one retry on JSON parse failure.
      let parsed = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await this._llm.complete({ system, messages, screenshot });
        try {
          parsed = parseJSONFromText(raw);
          messages.push({ role: 'assistant', content: raw });
          break;
        } catch (e) {
          if (attempt === 1) {
            // Both attempts failed — give up.
            this._onStatus({ state: 'error', error: e.message });
            return null;
          }
          // First attempt failed — retry once.
        }
      }

      if (parsed.done) {
        this._onStatus({ state: 'done' });
        return parsed.message ?? null;
      }

      if (parsed.actions && parsed.actions.length > 0) {
        this._onStatus({ state: 'acting' });
        await this._executor.execute(parsed.actions, pageState);
      }

      messages.push({ role: 'user', content: 'Continue.' });
    }

    this._onStatus({ state: 'error', error: 'Max iterations reached' });
    return null;
  }
}
