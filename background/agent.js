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
    verifyDone = false,
    verifyDoneFailOpen = false,
    onStatus = () => {},
    debugLog = null,
  }) {
    this._bridge = bridge;
    this._executor = executor;
    this._llm = llm;
    this._maxIterations = maxIterations;
    this._useVision = useVision;
    this._onStatus = onStatus;
    this._verifyDoneEnabled = verifyDone;
    // When verification is enabled but the verifier call fails (network error,
    // unparsable response), default to fail-CLOSED: treat the task as
    // unverified so the agent retries instead of silently reporting success.
    // Embedders that preferred the legacy fail-open behaviour can opt back in.
    this._verifyDoneFailOpen = verifyDoneFailOpen;
    this._debugLog = debugLog;   // fn({ sessionId, stepNum, turnNum, turnType, task, url, title, system, messages, screenshot, response, timestamp }) | null
    this._stopped = false;
    this._history = [];
    // Loop detection: track last 6 (url, actionStr) pairs so we can spot
    // identical actions being repeated on the same page with no progress.
    this._recentActions = [];
    this._sessionId = null;
    this._turnCounter = 0;
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
    // Clear loop-detection state so it never leaks between independent runs.
    // Without this, a new task starting on the same URL and issuing the same
    // first action inherits the last run's recent-action log and can be
    // incorrectly flagged as a loop after a single step.
    this._recentActions = [];
    // Generate a fresh session ID and reset turn counter for this run
    this._sessionId = Math.random().toString(36).slice(2, 8);
    this._turnCounter = 0;

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
        screenshot = await this._compressScreenshot(await this._bridge.takeScreenshot(), pageState);
      }

      this._status({ state: 'thinking' });

      const userMsg = this._assembleUserMessage(task, pageState, stepNum);
      const systemPrompt = this.systemPrompt();

      // Call LLM with a single-message array; history is embedded in the user message text.
      const mainMessages = [{ role: 'user', content: userMsg }];
      let raw = await this._llmComplete(
        { system: systemPrompt, messages: mainMessages, screenshot },
        { stepNum, turnType: 'main' }
      );
      if (this._stopped) {
        this._status({ state: 'stopped' });
        return null;
      }

      // ── Parse JSON (with one retry on failure) ─────────────────────────────
      let parsed = null;
      try {
        parsed = parseJSONFromText(raw);
      } catch (_) {
        // First parse failed — send the bad response back and ask for valid JSON.
        const retryMessages = [
          { role: 'user',      content: userMsg },
          { role: 'assistant', content: raw },
          { role: 'user',      content: 'Your response was not valid JSON. Reply with ONLY a raw JSON object — no prose, no markdown, no code fences.' },
        ];
        raw = await this._llmComplete(
          { system: systemPrompt, messages: retryMessages, screenshot: null },
          { stepNum, turnType: 'json-retry' }
        );
        if (this._stopped) {
          this._status({ state: 'stopped' });
          return null;
        }
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
        const validationMessages = [
          { role: 'user',      content: userMsg },
          { role: 'assistant', content: raw },
          { role: 'user',      content: `Invalid action: ${validationError}` },
        ];
        raw = await this._llmComplete(
          { system: systemPrompt, messages: validationMessages, screenshot: null },
          { stepNum, turnType: 'validation-retry' }
        );
        if (this._stopped) {
          this._status({ state: 'stopped' });
          return null;
        }
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

      if (this._stopped) {
        this._status({ state: 'stopped' });
        return null;
      }

      if (action.done) {
        const doneMsg = action.done.message ?? '';
        if (!this._verifyDoneEnabled) {
          this._status({ state: 'done', message: doneMsg });
          return doneMsg;
        }
        // Take a fresh screenshot for verification (if vision enabled)
        let verifyShot = null;
        if (this._useVision) {
          verifyShot = await this._compressScreenshot(await this._bridge.takeScreenshot());
        }
        const verifyResult = await this._verifyDone(task, action.done, pageState, verifyShot);
        if (verifyResult.verified) {
          this._status({ state: 'done', message: verifyResult.message });
          return verifyResult.message;
        }
        // Verification failed — record why and continue
        histEntry.actionResult =
          `Done was declared but verification shows the task is not complete yet: ` +
          `${verifyResult.reason}. Please continue working on the task.`;
        await this._sleep(1500);
        continue;
      }

      this._status({ state: 'acting', actionsCount: 1 });

      try {
        await this._executor.execute(action, pageState);
        // If stop() was called while the executor was running, abort cleanly now.
        if (this._stopped) {
          this._status({ state: 'stopped' });
          return null;
        }
        // Record what ran so the LLM knows the action succeeded.
        // Without this, models repeat the same action every step because they
        // see an empty Action Result and assume nothing happened.
        const [actionName, actionParams] = Object.entries(action)[0];
        histEntry.actionResult = `Executed ${actionName}: ${JSON.stringify(actionParams)}`;
        // Wait for any triggered navigation or DOM update to settle.
        const tabId2 = await this._bridge.getActiveTabId();
        await this._bridge.waitForPageSettle(tabId2, 1500);
        // ── Loop detection ───────────────────────────────────────────────
        // Track (url, serialised-action) pairs to spot cycles of length 1, 2, or 3.
        const actionStr = JSON.stringify(action);
        this._recentActions.push({ url: pageState.url, actionStr });
        if (this._recentActions.length > 6) this._recentActions.shift();
        const loopLen = this._detectLoop();
        if (loopLen > 0) {
          histEntry.actionResult +=
            `\n<sys>LOOP DETECTED (cycle of ${loopLen} action(s)): You are repeating ` +
            `the same sequence of actions with no progress. Do NOT repeat them. ` +
            `Try a completely different approach: scroll to reveal new content, ` +
            `navigate to a different URL, interact with a different element, ` +
            `or — if a popup or overlay is blocking — try dismissing it first.</sys>`;
        }
      } catch (err) {
        // Stop was requested while the executor was running (e.g. mid-typing).
        // The abort() on the InputControlBridge rejected the promise; treat it
        // as a clean stop rather than an error.
        if (this._stopped || err.name === 'InputControlAbortError') {
          this._status({ state: 'stopped' });
          return null;
        }
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
    const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
    const INDEX_ACTIONS = new Set(['click', 'type', 'select_option', 'scroll_element']);
    const SCROLL_DIRECTIONS = new Set(['up', 'down']);
    const SCROLL_AMOUNTS = new Set(['small', 'medium', 'large']);

    if (INDEX_ACTIONS.has(name)) {
      const index = p.index;
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

    // Per-action shape checks for non-index actions (and extra checks for
    // scroll_element). Executor handles runtime/environmental failures; this
    // catches basic schema errors early so the LLM gets a corrective retry.
    switch (name) {
      case 'wait': {
        const s = p.seconds;
        if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) {
          return `Action "wait" requires a finite positive number for "seconds", got: ${JSON.stringify(s)}.`;
        }
        break;
      }
      case 'navigate': {
        const url = p.url;
        if (typeof url !== 'string' || url.trim() === '') {
          return `Action "navigate" requires a non-empty string "url", got: ${JSON.stringify(url)}.`;
        }
        break;
      }
      case 'scroll': {
        if (p.direction !== undefined && !SCROLL_DIRECTIONS.has(p.direction)) {
          return `Action "scroll" has invalid "direction": ${JSON.stringify(p.direction)}. Must be "up" or "down".`;
        }
        if (p.amount !== undefined && !SCROLL_AMOUNTS.has(p.amount)) {
          return `Action "scroll" has invalid "amount": ${JSON.stringify(p.amount)}. Must be "small", "medium", or "large".`;
        }
        break;
      }
      case 'scroll_element': {
        if (p.direction !== undefined && !SCROLL_DIRECTIONS.has(p.direction)) {
          return `Action "scroll_element" has invalid "direction": ${JSON.stringify(p.direction)}. Must be "up" or "down".`;
        }
        if (p.amount !== undefined && !SCROLL_AMOUNTS.has(p.amount)) {
          return `Action "scroll_element" has invalid "amount": ${JSON.stringify(p.amount)}. Must be "small", "medium", or "large".`;
        }
        break;
      }
      case 'done': {
        if (p.success !== undefined && typeof p.success !== 'boolean') {
          return `Action "done" has invalid "success": ${JSON.stringify(p.success)}. Must be a boolean if provided.`;
        }
        if (p.message !== undefined && typeof p.message !== 'string') {
          return `Action "done" has invalid "message": ${JSON.stringify(p.message)}. Must be a string if provided.`;
        }
        break;
      }
    }

    return null; // valid
  }

  /**
   * Detect repeating action cycles of length 1, 2, or 3.
   * Returns the cycle length detected (1, 2, or 3), or 0 if no loop.
   */
  _detectLoop() {
    const ra = this._recentActions;
    const len = ra.length;
    const eq = (a, b) => a.url === b.url && a.actionStr === b.actionStr;

    // Cycle 1: same action twice in a row
    if (len >= 2 && eq(ra[len - 1], ra[len - 2])) return 1;

    // Cycle 2: ABAB pattern
    if (len >= 4 &&
        eq(ra[len - 1], ra[len - 3]) &&
        eq(ra[len - 2], ra[len - 4])) return 2;

    // Cycle 3: ABCABC pattern
    if (len >= 6 &&
        eq(ra[len - 1], ra[len - 4]) &&
        eq(ra[len - 2], ra[len - 5]) &&
        eq(ra[len - 3], ra[len - 6])) return 3;

    return 0;
  }

  /**
   * Verify that the task was truly completed after the LLM declared done.
   * Sends the current page state (and optional screenshot) to the LLM for
   * a confirmation check.
   *
   * @param {string} task
   * @param {object} doneAction  - the done action object from the LLM
   * @param {object} pageState   - current page state at time of done declaration
   * @param {string|null} screenshot - compressed screenshot (or null)
   * @returns {Promise<{verified:boolean, message:string, reason:string}>}
   */
  async _verifyDone(task, doneAction, pageState, screenshot) {
    const doneMsg = doneAction.message ?? '';

    // Summarise the last few steps so the verifier has evidence of what
    // the agent actually did. Without this, tasks that end with a state
    // change the final page doesn't reflect — e.g. clicking Send in Gmail
    // returns to the inbox with no visible trace of the reply — look
    // incomplete on the final page alone.
    const recent = this._history.slice(-8);
    const historyBlock = recent.length
      ? recent.map(h =>
          `  step ${h.stepNumber}: ${h.nextGoal || '(no goal)'} — ${h.actionResult || '(no result recorded)'}`
        ).join('\n')
      : '  (no prior steps)';

    const verifyPrompt =
      `Original task: "${task}"\n\n` +
      `The agent declared completion with: "${doneMsg}"\n\n` +
      `Summary of the agent's recent steps (most recent last):\n${historyBlock}\n\n` +
      `Current page URL: ${pageState.url}\n` +
      `Current page content:\n${pageState.domText || '(empty)'}\n\n` +
      `Was the task truly completed? Use ALL of the evidence:\n` +
      `  • the recorded step history above (what the agent actually did),\n` +
      `  • the current page content and any \`current-value="..."\` attributes\n` +
      `    on form fields, which show what the user typed,\n` +
      `  • the current URL (navigation away from a compose/form page after a\n` +
      `    Send/Submit click is normal evidence of success — do NOT demand\n` +
      `    that typed text still be visible on the current page in that case),\n` +
      `  • the screenshot if provided.\n\n` +
      `Only mark the task as NOT verified when there is concrete evidence it\n` +
      `is still pending — e.g. a form that still shows an empty required\n` +
      `field the agent never filled, a visible error message, or a next-step\n` +
      `button the agent clearly still needs to press. Absence of evidence on\n` +
      `the final page is NOT evidence of absence when the step history shows\n` +
      `the action succeeded.\n\n` +
      `Reply ONLY with raw JSON — no prose, no markdown:\n` +
      `  {"verified": true, "message": "one-line success summary"}\n` +
      `  OR\n` +
      `  {"verified": false, "reason": "what is still missing or needs to be done"}`;

    let raw;
    try {
      raw = await this._llmComplete(
        {
          system:
            'You are a task verification assistant for a browser automation agent. ' +
            'You have access to the agent\'s step-by-step history AND the current ' +
            'browser state. Use BOTH sources of evidence. Prefer the step history ' +
            'when a successful action (Send, Submit, Post) would naturally leave ' +
            'the final page without a direct visual trace. ' +
            'Reply ONLY with raw JSON: {"verified": true/false, "message": "...", "reason": "..."}',
          messages: [{ role: 'user', content: verifyPrompt }],
          screenshot,
        },
        { stepNum: this._iteration, turnType: 'verify' }
      );
    } catch (err) {
      // Fail-closed by default: a verification outage must NOT masquerade as
      // a verified completion. Surface the failure as "unverified" so the
      // agent retries. Embedders can opt into legacy fail-open via the
      // verifyDoneFailOpen constructor flag.
      if (this._verifyDoneFailOpen) {
        return { verified: true, message: doneMsg, reason: '' };
      }
      return {
        verified: false,
        message: doneMsg,
        reason:
          `Verification call failed (${err?.message || 'unknown error'}). ` +
          `Treating task as not yet verified — please continue or retry.`,
      };
    }

    try {
      const parsed = parseJSONFromText(raw);
      if (parsed.verified === true) {
        return { verified: true, message: parsed.message || doneMsg, reason: '' };
      }
      if (parsed.verified === false) {
        return {
          verified: false,
          message: doneMsg,
          reason: parsed.reason || 'Verification did not confirm task completion',
        };
      }
      return {
        verified: false,
        message: doneMsg,
        reason: 'Verification returned unexpected JSON schema',
      };
    } catch (_) {
      // Unparsable verifier response — fail-closed by default.
      if (this._verifyDoneFailOpen) {
        return { verified: true, message: doneMsg, reason: '' };
      }
      return {
        verified: false,
        message: doneMsg,
        reason: 'Verifier returned unparsable JSON — treating as not yet verified.',
      };
    }
  }

  /**
   * Wrapper around this._llm.complete() that fires the debug log callback when
   * debug mode is active.  Drop-in replacement for direct _llm.complete calls.
   *
   * @param {object} params     - Passed as-is to this._llm.complete()
   * @param {object} meta
   * @param {number} meta.stepNum   - 0-based agent step
   * @param {string} meta.turnType  - 'main' | 'json-retry' | 'validation-retry' | 'verify'
   * @returns {Promise<string>}
   */
  async _llmComplete(params, { stepNum, turnType }) {
    const response = await this._llm.complete(params);
    if (this._debugLog) {
      this._turnCounter++;
      try {
        this._debugLog({
          sessionId:    this._sessionId,
          stepNum,
          turnNum:      this._turnCounter,
          turnType,
          task:         this._task || '',
          url:          this._url  || '',
          title:        this._title || '',
          system:       params.system,
          messages:     params.messages,
          screenshot:   params.screenshot || null,
          response,
          timestamp:    Date.now(),
        });
      } catch (logErr) {
        // Never let logging break the agent
        console.warn('[AgentCore] debugLog callback threw:', logErr);
      }
    }
    return response;
  }

  /**
   * Compress a PNG screenshot data URL into a smaller JPEG using OffscreenCanvas.
   * Scales down to max 1280px wide and encodes at 70% JPEG quality.
   * Optionally overlays red numbered badges on each interactive element.
   * Falls back to the original data URL if compression fails.
   *
   * @param {string|null} dataUrl
   * @param {object|null} [pageState]  - pageState with .elements, .viewportWidth, .viewportHeight
   * @returns {Promise<string|null>}
   */
  async _compressScreenshot(dataUrl, pageState = null) {
    if (!dataUrl) return null;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      const maxWidth = 1280;
      const scale = Math.min(1, maxWidth / bitmap.width);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();

      // ── Annotate interactive elements with red index badges ──────────────
      if (pageState && Array.isArray(pageState.elements) && pageState.elements.length > 0) {
        const vw = pageState.viewportWidth || 1;
        const vh = pageState.viewportHeight || 1;
        const scaleX = w / vw;
        const scaleY = h / vh;

        for (const el of pageState.elements) {
          if (!el.inViewport) continue;
          const { x, y, w: ew, h: eh } = el.rect;
          // Centre of the element in canvas coordinates
          const cx = Math.round((x + ew / 2) * scaleX);
          const cy = Math.round((y + eh / 2) * scaleY);

          const label = String(el.index);
          const fontSize = Math.max(10, Math.min(16, Math.round(12 * scaleX)));
          ctx.font = `bold ${fontSize}px sans-serif`;
          const textMetrics = ctx.measureText(label);
          const padding = 3;
          const badgeW = Math.round(textMetrics.width + padding * 2);
          const badgeH = fontSize + padding * 2;
          const bx = cx - Math.round(badgeW / 2);
          const by = cy - Math.round(badgeH / 2);

          // Red rounded-rect background
          const r = Math.min(4, Math.round(badgeH / 2));
          ctx.beginPath();
          ctx.moveTo(bx + r, by);
          ctx.lineTo(bx + badgeW - r, by);
          ctx.quadraticCurveTo(bx + badgeW, by, bx + badgeW, by + r);
          ctx.lineTo(bx + badgeW, by + badgeH - r);
          ctx.quadraticCurveTo(bx + badgeW, by + badgeH, bx + badgeW - r, by + badgeH);
          ctx.lineTo(bx + r, by + badgeH);
          ctx.quadraticCurveTo(bx, by + badgeH, bx, by + badgeH - r);
          ctx.lineTo(bx, by + r);
          ctx.quadraticCurveTo(bx, by, bx + r, by);
          ctx.closePath();
          ctx.fillStyle = 'rgba(220, 30, 30, 0.9)';
          ctx.fill();

          // White text
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + padding, by + Math.round(badgeH / 2));
        }
      }

      const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });

      // Convert to base64 data URL (FileReader not available in service workers)
      const buf = await jpegBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
      }
      return `data:image/jpeg;base64,${btoa(binary)}`;
    } catch (e) {
      console.warn('[AgentCore] Screenshot compression failed, using original:', e);
      return dataUrl;
    }
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
  \\t         = child of the element above (DOM hierarchy)
  data-scrollable="top=0, bottom=340" = this element is scrollable, 340px below
  current-value="..." = the text the user has already typed into this form field
    (inputs, textareas, contenteditable surfaces). Use it to tell whether a field
    is already filled before typing again, and as evidence that a previous
    typing action succeeded.

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
3. After an action, new elements may appear — check the updated browser state and act on them.
4. Click a field before typing into it — but use "type" action which handles this automatically.
5. If a CAPTCHA appears, call done(success=false) with a clear explanation.
6. Track progress in "memory" — the next step will not see the page as it was.
7. If stuck (same state 2 steps in a row), try a different approach or scroll.
8. Keep evaluation/memory/next_goal brief and factual.`;
  }
}
