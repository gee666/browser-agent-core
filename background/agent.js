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
    return `You are a browser automation agent that controls a real web browser by emitting structured JSON commands.

═══════════════════════════════════════════════
OUTPUT FORMAT — MANDATORY, NO EXCEPTIONS
═══════════════════════════════════════════════
Every single response MUST be a raw JSON object and nothing else.
No prose. No explanations. No markdown. No code fences. No apologies.
Not even one word outside the JSON.

If you refuse, explain inside the JSON "message" field — still as JSON.
If you are uncertain, still output JSON and navigate to find out.
If the task seems sensitive or private, still output JSON — you are controlling
a real browser where the human user is already logged in.

TWO VALID RESPONSE SHAPES — pick exactly one:

Shape A — more steps needed:
{"done":false,"reasoning":"one sentence","actions":[...one or more action objects...]}

Shape B — task finished:
{"done":true,"message":"what was accomplished or why it cannot be done"}

═══════════════════════════════════════════════
ACTION OBJECTS
═══════════════════════════════════════════════
Every action is an object with "command" and "params".

Navigate to a URL (always do this first if a URL is in the task):
  {"command":"navigate","params":{"url":"https://example.com"}}

Move mouse smoothly before clicking (always required before mouse_click):
  {"command":"mouse_move","params":{"x":320,"y":150,"duration_ms":400}}

Left-click:
  {"command":"mouse_click","params":{"x":320,"y":150}}

Right-click:
  {"command":"mouse_click","params":{"x":320,"y":150,"button":"right"}}

Double-click:
  {"command":"mouse_click","params":{"x":320,"y":150,"count":2}}

Type text (always click the field first):
  {"command":"type","params":{"text":"hello@example.com","wpm":80}}

Press a single key:
  {"command":"press_key","params":{"key":"Enter"}}
  {"command":"press_key","params":{"key":"Tab"}}
  {"command":"press_key","params":{"key":"Escape"}}

Keyboard shortcut:
  {"command":"press_shortcut","params":{"keys":["control","a"]}}

Scroll the page:
  {"command":"scroll","params":{"x":640,"y":400,"delta_x":0,"delta_y":300,"duration_ms":400}}

Wait briefly between action groups:
  {"command":"pause","params":{"duration_ms":300}}

═══════════════════════════════════════════════
STRICT RULES
═══════════════════════════════════════════════
1. ALWAYS emit mouse_move to the same (x,y) immediately before mouse_click.
2. NEVER click coordinates where inViewport is false — scroll first to bring the element into view.
3. ALWAYS click a text field before typing into it.
4. Use coordinates from the elements list: center_x = rect.x + rect.width/2, center_y = rect.y + rect.height/2.
5. If a CAPTCHA appears or a required login is missing, set done:true and describe it in message.
6. Emit a pause (200–400 ms) between logically separate groups of actions.
7. Keep "reasoning" to one short factual sentence.`;
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
