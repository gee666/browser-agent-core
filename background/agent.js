import { parseJSONFromText } from './llm/utils.js';

/**
 * AgentCore orchestrates the LLM reasoning loop for browser automation (v2).
 *
 * v2 changes vs v1:
 *  - History is a rolling array of step summaries (not full DOM messages).
 *  - LLM always receives a single user message per call with embedded history.
 *  - LLM response shape: { evaluation_previous_goal, memory, next_goal, action: { NAME: params } }
 *  - `done` is action.done, not a top-level field.
 *  - Executor receives a single action object, not an array.
 */
export class AgentCore {
  /**
   * @param {object} options
   * @param {object} options.bridge           - BrowserBridge instance
   * @param {object} options.executor         - ActionExecutor instance
   * @param {object} options.llm              - LLMProvider instance
   * @param {number} [options.maxIterations=20]
   * @param {boolean} [options.useVision=false]
   * @param {function} [options.onStatus]     - Called with {state, ...} on each state change
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
    this._history = [];
  }

  /** Signal the running loop to stop after the current iteration. */
  stop() {
    this._stopped = true;
  }

  _status(extra) {
    const s = {
      task: this._task || null,
      iteration: this._iteration,
      maxIterations: this._maxIterations,
      url: this._url || null,
      title: this._title || null,
      message: null,
      timestamp: Date.now(),
      ...extra,
    };
    this._onStatus(s);
    this._bridge.sendStatus(s);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Run the agent loop for the given task.
   * @param {string} task
   * @returns {Promise<string|null>} The done message from the LLM, or null.
   */
  async run(task) {
    this._stopped = false;
    this._task = task;
    this._iteration = 0;
    this._url = null;
    this._title = null;
    this._history = [];

    this._status({ state: 'running' });

    // If the task contains a URL, navigate there first.
    const urlMatch = /https?:\/\/[^\s]+/.exec(task);
    if (urlMatch) {
      await this._bridge.navigate(urlMatch[0]);
      await this._bridge.waitForPageSettle();
    }

    for (let stepNum = 0; stepNum < this._maxIterations; stepNum++) {
      this._iteration = stepNum;

      if (this._stopped) {
        this._status({ state: 'stopped' });
        return null;
      }

      const tabId = await this._bridge.getActiveTabId();
      const pageState = await this._bridge.getPageState(tabId);
      this._url = pageState.url;
      this._title = pageState.title;

      let screenshot = null;
      if (this._useVision) {
        screenshot = await this._bridge.takeScreenshot();
      }

      this._status({ state: 'thinking' });

      const userMsg = this._assembleUserMessage(task, pageState, stepNum);

      // Call LLM with a single-message array; history is embedded in the user message text.
      let raw = await this._llm.complete({
        system: this.systemPrompt(),
        messages: [{ role: 'user', content: userMsg }],
        screenshot,
      });

      // ── Parse JSON (with one retry on failure) ─────────────────────────────
      let parsed = null;
      try {
        parsed = parseJSONFromText(raw);
      } catch (_) {
        // First parse failed — send the bad response back and ask for valid JSON.
        raw = await this._llm.complete({
          system: this.systemPrompt(),
          messages: [
            { role: 'user',      content: userMsg },
            { role: 'assistant', content: raw },
            { role: 'user',      content: 'Your response was not valid JSON. Reply with ONLY a raw JSON object — no prose, no markdown, no code fences.' },
          ],
          screenshot: null,
        });
        try {
          parsed = parseJSONFromText(raw);
        } catch (e2) {
          this._status({ state: 'error', message: `JSON parse failed: ${e2.message}` });
          return null;
        }
      }

      // ── Validate action (with one retry if invalid) ────────────────────────
      const validationError = this._validateAction(parsed.action, pageState);
      if (validationError) {
        raw = await this._llm.complete({
          system: this.systemPrompt(),
          messages: [
            { role: 'user',      content: userMsg },
            { role: 'assistant', content: raw },
            { role: 'user',      content: `Invalid action: ${validationError}` },
          ],
          screenshot: null,
        });
        try {
          parsed = parseJSONFromText(raw);
        } catch (e2) {
          this._status({ state: 'error', message: `JSON parse failed after validation retry: ${e2.message}` });
          return null;
        }
        // If it's still invalid after the retry we let the executor surface the
        // error rather than looping forever.
      }

      // Append step summary to history (cap at 15 entries).
      const histEntry = {
        stepNumber: stepNum,
        evaluation: parsed.evaluation_previous_goal || '',
        memory: parsed.memory || '',
        nextGoal: parsed.next_goal || '',
        actionResult: '',
      };

      // Step warnings: modify actionResult of the current entry.
      const stepsRemaining = this._maxIterations - stepNum;
      if (stepsRemaining === 5) {
        histEntry.actionResult =
          '<sys>Warning: only 5 steps remaining. Prioritise completion.</sys>';
      } else if (stepsRemaining === 2) {
        histEntry.actionResult =
          '<sys>CRITICAL: only 2 steps left. Call done() now even if incomplete.</sys>';
      }

      this._history.push(histEntry);
      if (this._history.length > 15) {
        this._history.shift();
      }

      const action = parsed.action || {};

      if (action.done) {
        this._status({ state: 'done', message: action.done.message ?? null });
        return action.done.message ?? null;
      }

      this._status({ state: 'acting', actionsCount: 1 });

      try {
        await this._executor.execute(action, pageState);
        // Record what ran so the LLM knows the action succeeded.
        // Without this, models repeat the same action every step because they
        // see an empty Action Result and assume nothing happened.
        const [actionName, actionParams] = Object.entries(action)[0];
        histEntry.actionResult = `Executed ${actionName}: ${JSON.stringify(actionParams)}`;
        // Wait for any triggered navigation or DOM update to settle.
        const tabId2 = await this._bridge.getActiveTabId();
        await this._bridge.waitForPageSettle(tabId2, 1500);
      } catch (err) {
        if (err.name === 'ExecutorError') {
          // Recoverable: record the failure in history so the LLM can adapt
          // (e.g. stale index, element off-screen, page changed).
          // Do NOT abort — let the agent try a different approach next step.
          histEntry.actionResult = `Action failed: ${err.message}`;
          this._status({ state: 'error', message: err.message });
          // continue to next iteration
        } else {
          throw err; // unexpected — propagate
        }
      }

      await this._sleep(1500);
    }

    this._status({ state: 'error', message: 'Max iterations reached' });
    return null;
  }

  /**
   * Assemble the single user message sent to the LLM each step.
   * Embeds task context, rolling history, and current browser state.
   */
  _assembleUserMessage(task, pageState, stepNum) {
    const sections = [];

    sections.push(
      `<agent_state>\n` +
      `<user_request>\n${task}\n</user_request>\n` +
      `<step_info>\nStep ${stepNum + 1} of ${this._maxIterations}. ` +
      `Time: ${new Date().toLocaleString()}\n</step_info>\n` +
      `</agent_state>`
    );

    if (this._history.length > 0) {
      const histLines = this._history.map(h =>
        `<step_${h.stepNumber}>\n` +
        `Evaluation: ${h.evaluation}\n` +
        `Memory: ${h.memory}\n` +
        `Next Goal: ${h.nextGoal}\n` +
        `Action Result: ${h.actionResult}\n` +
        `</step_${h.stepNumber}>`
      ).join('\n');
      sections.push(`<agent_history>\n${histLines}\n</agent_history>`);
    }

    const pageHeader =
      `Current Page: ${pageState.title} — ${pageState.url}\n` +
      `Viewport: ${pageState.viewportWidth}×${pageState.viewportHeight}px, ` +
      `page ${pageState.pageWidth}×${pageState.pageHeight}px, ` +
      `scroll (${pageState.scrollX || 0}, ${pageState.scrollY || 0})`;

    const validIndices = (pageState.elements || []).map(e => e.index);
    const indicesLine = validIndices.length > 0
      ? `Valid element indices on this page: [${validIndices.join(', ')}]`
      : '(No interactive elements detected on this page)';

    sections.push(
      `<browser_state>\n${pageHeader}\n\n${pageState.domText || '(no page content)'}\n\n${indicesLine}\n</browser_state>`
    );

    return sections.join('\n\n');
  }

  /**
   * Validates that the parsed action is structurally sound and references
   * element indices that actually exist in the current page state.
   *
   * Returns null when valid, or a plain-English error string that is sent
   * back to the LLM as a correction prompt.
   *
   * @param {object} action
   * @param {object} pageState
   * @returns {string|null}
   */
  _validateAction(action, pageState) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return 'The "action" field is missing or not a JSON object. Provide exactly one action.';
    }

    const entries = Object.entries(action);
    if (entries.length === 0) {
      return 'The "action" object is empty. Provide exactly one action key.';
    }
    if (entries.length > 1) {
      return `The "action" object must have exactly one key, got: ${Object.keys(action).join(', ')}. Remove all but one.`;
    }

    const [name, params] = entries[0];
    const INDEX_ACTIONS = new Set(['click', 'type', 'select_option', 'scroll_element']);

    if (INDEX_ACTIONS.has(name)) {
      const index = params?.index;
      if (typeof index !== 'number') {
        return `Action "${name}" requires a numeric "index" parameter, got: ${JSON.stringify(index)}.`;
      }
      const validIndices = (pageState.elements || []).map(e => e.index);
      if (!validIndices.includes(index)) {
        const hint = validIndices.length > 0
          ? `Valid indices are: [${validIndices.join(', ')}].`
          : 'There are no interactive elements on this page.';
        return (
          `Element index ${index} does not exist in the current page. ` +
          `${hint} ` +
          `Only use indices shown between [brackets] in the browser state.`
        );
      }
    }

    return null; // valid
  }

  systemPrompt() {
    return `You are an AI agent that automates browser tasks in an iterative loop.

══════════════════════════════════════════════════════════════
INPUT — at every step you receive:
══════════════════════════════════════════════════════════════
<agent_state>    : the task and current step number
<agent_history>  : summaries of previous steps (NOT the page — just your notes)
<browser_state>  : current URL, page dimensions, interactive elements

══════════════════════════════════════════════════════════════
BROWSER STATE FORMAT
══════════════════════════════════════════════════════════════
Elements appear as:
  [index]<tag attr=value>text</tag>
  *[index]  = element that NEWLY appeared since the last step (pay attention)
  \\t         = child of the element above (DOM hierarchy)
  data-scrollable="top=0, bottom=340" = this element is scrollable, 340px below

Only elements with [index] are interactive. Use ONLY those indices.
Pure text lines without [index] are informational only.

══════════════════════════════════════════════════════════════
OUTPUT FORMAT — MANDATORY, NO EXCEPTIONS
══════════════════════════════════════════════════════════════
Every response MUST be raw JSON. No prose, no markdown, no code fences.

{
  "evaluation_previous_goal": "One sentence: was your last action successful?",
  "memory": "1-3 sentences: what have you done, what matters for the rest",
  "next_goal": "One sentence: your immediate next goal",
  "action": { "ACTION_NAME": { ...params } }
}

Exactly ONE action per response. The harness handles scroll, mouse movement,
and timing automatically — you only say WHAT to do, not HOW.

══════════════════════════════════════════════════════════════
ACTIONS
══════════════════════════════════════════════════════════════
Click an element:
  {"action": {"click": {"index": 5}}}

Click and type text (clears existing content first):
  {"action": {"type": {"index": 3, "text": "hello@example.com"}}}

Select a dropdown option:
  {"action": {"select_option": {"index": 7, "text": "United States"}}}

Scroll the page:
  {"action": {"scroll": {"direction": "down", "amount": "medium"}}}
  direction: "up" | "down"
  amount: "small" (200px) | "medium" (500px) | "large" (full page height)

Scroll a specific scrollable element:
  {"action": {"scroll_element": {"index": 4, "direction": "down", "amount": "medium"}}}

Navigate to a URL:
  {"action": {"navigate": {"url": "https://example.com"}}}

Wait briefly:
  {"action": {"wait": {"seconds": 2}}}

Finish the task:
  {"action": {"done": {"success": true, "message": "Completed: found 127 friends"}}}
  {"action": {"done": {"success": false, "message": "Cannot proceed: CAPTCHA required"}}}

══════════════════════════════════════════════════════════════
RULES
══════════════════════════════════════════════════════════════
1. Only use indices shown in the current browser state.
2. NEVER use an index that is not visible — scroll first if needed.
3. If an element is new (*[index]), it probably appeared due to your last action — act on it.
4. Click a field before typing into it — but use "type" action which handles this automatically.
5. If a CAPTCHA appears, call done(success=false) with a clear explanation.
6. Track progress in "memory" — the next step will not see the page as it was.
7. If stuck (same state 2 steps in a row), try a different approach or scroll.
8. Keep evaluation/memory/next_goal brief and factual.`;
  }
}
