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
  _status(extra) {
    const s = {
      task: this._task || null,
      iteration: this._iteration,
      maxIterations: this._maxIterations,
      url: this._url || null,
      title: this._title || null,
      message: null,
      actionsCount: null,
      timestamp: Date.now(),
      ...extra,
    };
    this._onStatus(s);
    this._bridge.sendStatus(s);
  }

  async run(task) {
    this._stopped = false;
    this._task = task;
    this._iteration = 0;
    this._url = null;
    this._title = null;

    this._status({ state: 'running' });

    // If the task contains a URL, navigate there first.
    const urlMatch = /https?:\/\/[^\s]+/.exec(task);
    if (urlMatch) {
      await this._bridge.navigate(urlMatch[0]);
      await this._bridge.waitForPageSettle();
    }

    const messageHistory = [];

    for (let iteration = 0; iteration < this._maxIterations; iteration++) {
      this._iteration = iteration;

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

      const userMsg = this.buildUserMessage(task, pageState, iteration, messageHistory);
      const userContent = screenshot
        ? [{ type: 'text', text: userMsg }, { type: 'image_url', image_url: { url: screenshot } }]
        : userMsg;

      messageHistory.push({ role: 'user', content: userContent });

      // Cap history at 10 pairs (20 messages)
      const cappedHistory = messageHistory.slice(-20);

      // Call LLM, with one retry on JSON parse failure.
      let parsed = null;
      let raw = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        raw = await this._llm.complete({
          system: this.systemPrompt(),
          messages: cappedHistory,
          screenshot: null, // already embedded in last user message above
        });
        try {
          parsed = parseJSONFromText(raw);
          break;
        } catch (e) {
          if (attempt === 1) {
            this._status({ state: 'error', message: `JSON parse failed: ${e.message}` });
            return null;
          }
          // Retry: ask LLM to return valid JSON
          messageHistory.push({ role: 'assistant', content: raw });
          messageHistory.push({ role: 'user', content: 'Your response was not valid JSON. Please respond with ONLY a JSON object, no prose or markdown.' });
        }
      }

      messageHistory.push({ role: 'assistant', content: raw });

      if (parsed.done) {
        this._status({ state: 'done', message: parsed.message ?? null });
        return parsed.message ?? null;
      }

      const actions = parsed.actions || [];
      this._status({ state: 'acting', actionsCount: actions.length });

      if (actions.length > 0) {
        await this._executor.execute(actions, pageState);
      }

      await new Promise(r => setTimeout(r, 1500));
    }

    this._status({ state: 'error', message: 'Max iterations reached' });
    return null;
  }

  systemPrompt() {
    return `You are a browser automation agent. You control a real web browser.
You are given:
- A task to complete
- A list of interactive elements on the current page with their IDs, labels, types, and viewport-relative coordinates
- The current URL and page title
- Optionally a screenshot of the visible viewport

Respond ONLY with a JSON object. No prose, no markdown, no code fences. Two possible shapes:

1. More actions needed:
{"done":false,"reasoning":"brief explanation","actions":[...]}

2. Task complete:
{"done":true,"message":"description of what was accomplished"}

Action shapes:
- {"command":"mouse_click","params":{"x":320,"y":150}}
- {"command":"mouse_click","params":{"x":320,"y":150,"button":"right"}}
- {"command":"mouse_click","params":{"x":320,"y":150,"count":2}}
- {"command":"type","params":{"text":"hello@example.com","wpm":80}}
- {"command":"press_key","params":{"key":"Tab"}}
- {"command":"press_key","params":{"key":"Enter"}}
- {"command":"press_shortcut","params":{"keys":["control","a"]}}
- {"command":"scroll","params":{"x":640,"y":400,"delta_x":0,"delta_y":300,"duration_ms":400}}
- {"command":"mouse_move","params":{"x":320,"y":150,"duration_ms":400}}
- {"command":"pause","params":{"duration_ms":300}}
- {"command":"navigate","params":{"url":"https://example.com"}}

RULES:
1. Use coordinates from the elements list. Center of element = rect.x + rect.width/2, rect.y + rect.height/2.
2. NEVER click an element where inViewport is false. First emit a scroll command to bring it into view.
3. Always click a field before typing into it.
4. Include a pause (200-400ms) between groups of related actions.
5. If a CAPTCHA or login wall blocks progress and you cannot proceed, set done:true with a clear message.
6. If asked to navigate to a URL, use the navigate command.
7. Keep reasoning brief and factual.`;
  }

  buildUserMessage(task, pageState, iteration, history) {
    const { url, title, elements = [], viewportWidth = 0, viewportHeight = 0, context = {} } = pageState;
    const sx = Math.round(context.scrollX || 0);
    const sy = Math.round(context.scrollY || 0);

    const elLines = elements.map((el, i) => {
      const cx = Math.round(el.rect.x + el.rect.width / 2);
      const cy = Math.round(el.rect.y + el.rect.height / 2);
      const typeStr = el.type ? `[${el.type}]` : '';
      const labelStr = el.label ? ` "${el.label}"` : '';
      const phStr = el.placeholder ? ` placeholder="${el.placeholder}"` : '';
      const vpStr = el.inViewport ? '\u2713 viewport' : '\u2717 not in viewport';
      return `[${el.id}]  ${el.tag}${typeStr}${labelStr}${phStr}  at (${el.rect.x},${el.rect.y}) ${el.rect.width}\u00d7${el.rect.height}  center(${cx},${cy})  ${vpStr}`;
    }).join('\n');

    let msg = `Task: ${task}\n\nCurrent page: ${url} \u2014 "${title}"\n\nInteractive elements (${elements.length} total, viewport ${viewportWidth}\u00d7${viewportHeight}, scroll ${sx},${sy}):\n${elLines || '(none)'}`;

    if (iteration > 0) {
      msg += '\n\nPrevious actions have been performed. Evaluate current state and continue or declare done.';
    }

    return msg;
  }
}
