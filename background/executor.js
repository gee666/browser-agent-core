/**
 * ActionExecutor v2 — receives ONE semantic action object and executes it.
 */

export class ExecutorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class ActionExecutor {
  /**
   * @param {{ bridge: object, inputControl: object }} options
   */
  constructor({ bridge, inputControl }) {
    this._bridge = bridge;
    this._inputControl = inputControl;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Execute a single semantic action against the current page state.
   * @param {{ [actionName: string]: object }} action
   * @param {object} pageState
   */
  async execute(action, pageState) {
    const entries = Object.entries(action);
    if (entries.length !== 1) {
      throw new ExecutorError(
        `Action must have exactly one key, got: ${Object.keys(action).join(', ')}`,
      );
    }
    const [name, params] = entries[0];

    switch (name) {
      case 'click':          return this._executeClick(params.index, pageState);
      case 'type':           return this._executeType(params.index, params.text, pageState);
      case 'select_option':  return this._executeSelectOption(params.index, params.text, pageState);
      case 'scroll':         return this._executeScroll(params.direction, params.amount, pageState);
      case 'scroll_element': return this._executeScrollElement(params.index, params.direction, params.amount, pageState);
      case 'navigate':       return this._executeNavigate(params.url);
      case 'wait':           return this._sleep(params.seconds * 1000);
      case 'done':           return { done: true, success: params.success, message: params.message };
      default:               throw new ExecutorError(`Unknown action: ${name}`);
    }
  }

  // ── private action handlers ────────────────────────────────────────────────

  async _executeClick(index, pageState) {
    const { x, y, pageState: freshState } = await this._getValidatedCoords(index, pageState);
    const ctx = freshState.context;
    await this._inputControl.execute('mouse_move', { x, y, duration_ms: 350 + this._rand(0, 150) }, ctx);
    await this._sleep(80 + this._rand(0, 60));
    await this._inputControl.execute('mouse_click', { x, y, button: 'left', count: 1 }, ctx);
    await this._sleep(100 + this._rand(0, 100));
  }

  async _executeType(index, text, pageState) {
    const tabId = await this._bridge.getActiveTabId();
    const MAX_TYPE_ATTEMPTS = 2;

    for (let attempt = 0; attempt < MAX_TYPE_ATTEMPTS; attempt++) {
      // Re-fetch state on retry so we have fresh coords and context.
      if (attempt > 0) {
        await this._sleep(300);
        pageState = await this._bridge.getPageState(tabId);
      }

      const { x, y, pageState: freshState } = await this._getValidatedCoords(index, pageState);
      const ctx = freshState.context;

      // 1. Native click to position the cursor.
      await this._inputControl.execute('mouse_move', { x, y, duration_ms: 350 + this._rand(0, 150) }, ctx);
      await this._sleep(80 + this._rand(0, 60));
      await this._inputControl.execute('mouse_click', { x, y, button: 'left', count: 1 }, ctx);
      await this._sleep(150);

      // 2. Force DOM focus via the content script.
      //    A native click does not always transfer keyboard focus before the next
      //    keystroke arrives (race between the OS input queue and Chrome's focus
      //    handling).  el.focus() is synchronous inside the page so it is
      //    guaranteed to be in effect before we send Ctrl+A.
      await this._bridge.focusElement(tabId, index);
      await this._sleep(100);

      // 3. Select all existing content inside the element and delete it.
      await this._inputControl.execute('press_shortcut', { keys: ['control', 'a'] }, ctx);
      await this._sleep(80);
      await this._inputControl.execute('press_key', { key: 'Delete' }, ctx);
      await this._sleep(80);

      // 4. Type the new text.
      await this._inputControl.execute('type', { text, wpm: 55 + this._rand(0, 15) }, ctx);
      await this._sleep(200);

      // 5. Verify: read back the element value and compare to what was typed.
      const actual = await this._bridge.getElementValue(tabId, index);
      if (this._typeSucceeded(actual, text)) return; // ✓

      // Verification failed on this attempt — log and retry if we have attempts left.
      if (attempt < MAX_TYPE_ATTEMPTS - 1) continue;

      // All attempts exhausted — surface a clear ExecutorError so the agent
      // records it in history and lets the LLM decide what to do next.
      const got  = actual == null ? '(could not read field)' : `"${String(actual).slice(0, 60)}${actual.length > 60 ? '...' : ''}"`;
      const want = `"${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`;
      throw new ExecutorError(
        `Text input verification failed after ${MAX_TYPE_ATTEMPTS} attempts: ` +
        `expected ${want} but field contains ${got}. ` +
        `The field may need a different interaction (direct click, special key, etc.).`,
      );
    }
  }

  /**
   * Returns true when the text we read back from the element is a close-enough
   * match to what we typed.
   *
   * Exact equality is ideal, but real pages may trim whitespace, apply
   * max-length limits, or run through autocomplete — so we also accept:
   *   • The field value starts with the first 50 chars of the expected text, AND
   *   • At least 80 % of the expected length was accepted.
   *
   * If we could not read the value at all (null) we optimistically assume
   * success rather than retrying blindly (e.g. rich-text editors that hide
   * the value from DOM inspection).
   */
  _typeSucceeded(actual, expected) {
    if (actual === null) return true; // can't read — assume ok
    const a = String(actual).trim();
    const e = expected.trim();
    if (a === e) return true;
    const checkLen = Math.min(e.length, 50);
    return (
      a.slice(0, checkLen) === e.slice(0, checkLen) &&
      a.length >= Math.floor(e.length * 0.8)
    );
  }

  async _executeScroll(direction, amount, pageState) {
    const AMOUNTS = { small: 200, medium: 500, large: pageState.viewportHeight };
    const delta = (direction === 'down' ? 1 : -1) * (AMOUNTS[amount] || 500);
    await this._inputControl.execute('scroll', {
      x: Math.round(pageState.viewportWidth / 2),
      y: Math.round(pageState.viewportHeight / 2),
      delta_x: 0,
      delta_y: delta,
      duration_ms: 300,
    }, pageState.context);
  }

  async _executeScrollElement(index, direction, amount, pageState) {
    const { x, y, pageState: freshState } = await this._getValidatedCoords(index, pageState);
    const AMOUNTS = { small: 200, medium: 500, large: pageState.viewportHeight };
    const delta = (direction === 'down' ? 1 : -1) * (AMOUNTS[amount] || 500);
    await this._inputControl.execute('scroll', {
      x, y, delta_x: 0, delta_y: delta, duration_ms: 300,
    }, freshState.context);
  }

  async _executeSelectOption(index, text, pageState) {
    // Click to open dropdown
    await this._executeClick(index, pageState);
    await this._sleep(300);
    // Re-fetch state — new options may have appeared
    const tabId = await this._bridge.getActiveTabId();
    const newState = await this._bridge.getPageState(tabId);
    // Find option by text match
    const option = newState.elements.find(el =>
      (el.text || '').toLowerCase().includes(text.toLowerCase()) ||
      (el.attrs && (el.attrs.value || '').toLowerCase().includes(text.toLowerCase()))
    );
    if (!option) throw new ExecutorError(`Option with text "${text}" not found after opening dropdown`);
    await this._executeClick(option.index, newState);
  }

  async _executeNavigate(url) {
    await this._bridge.navigate(url);
    await this._bridge.waitForPageSettle();
  }

  // ── coordinate helpers ─────────────────────────────────────────────────────

  /**
   * Resolves and validates coordinates for an element.
   *
   * If the element is outside the viewport, scrolls to it (via window.scrollTo —
   * pixel-perfect, unlike a wheel event), re-fetches the page state, and retries
   * up to MAX_SCROLL_ATTEMPTS times.
   *
   * After all scroll attempts, validates that the final coordinates lie inside
   * the viewport before returning, so the native host never sees out-of-bounds
   * coordinates.
   */
  async _getValidatedCoords(index, pageState) {
    let el = (pageState.elements || []).find(e => e.index === index);

    // Element missing from the cached pageState — the page may have re-rendered
    // since the state was fetched (JS framework update, lazy load, navigation).
    // Re-fetch once to get the current DOM before giving up.
    if (!el) {
      const tabId = await this._bridge.getActiveTabId();
      const freshState = await this._bridge.getPageState(tabId);
      el = (freshState.elements || []).find(e => e.index === index);
      if (el) {
        pageState = freshState; // use fresh state for everything that follows
      } else {
        const available = (freshState.elements || []).map(e => e.index).join(', ');
        throw new ExecutorError(
          `Unknown element index ${index}. ` +
          `Page now has ${(freshState.elements || []).length} elements ` +
          `with indices: [${available || 'none'}]. ` +
          `The page may have changed — use an index from the current browser state.`,
        );
      }
    }

    const tabId = await this._bridge.getActiveTabId();
    const MAX_SCROLL_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS && !el.inViewport; attempt++) {
      await this._scrollToElement(el, pageState, tabId);
      await this._sleep(600);
      const newState = await this._bridge.getPageState(tabId);
      const newEl = newState.elements.find(e => e.index === index);
      if (!newEl) throw new ExecutorError(`Element ${index} disappeared after scroll`);
      el = newEl;
      pageState = newState;
    }

    const cx = el.rect.x + el.rect.w / 2;
    const cy = el.rect.y + el.rect.h / 2;
    const { x, y } = this._jitterCoords(el.rect, cx, cy);
    const rx = Math.round(x);
    const ry = Math.round(y);

    // Guard: if coords are still outside viewport after all scroll attempts,
    // throw a clear ExecutorError so the agent can recover, instead of letting
    // the native host emit a cryptic "outside virtual desktop bounds" error.
    const vw = pageState.viewportWidth;
    const vh = pageState.viewportHeight;
    const MARGIN = 2; // px — keep away from exact viewport edge
    if (rx < MARGIN || rx > vw - MARGIN || ry < MARGIN || ry > vh - MARGIN) {
      throw new ExecutorError(
        `Element ${index} coords (${rx}, ${ry}) are outside the safe viewport area ` +
        `(${MARGIN}..${vw - MARGIN} x ${MARGIN}..${vh - MARGIN}) ` +
        `after ${MAX_SCROLL_ATTEMPTS} scroll attempt(s). ` +
        `Element rect: x=${el.rect.x} y=${el.rect.y} w=${el.rect.w} h=${el.rect.h} ` +
        `inViewport=${el.inViewport}.`,
      );
    }

    return { x: rx, y: ry, el, pageState };
  }

  /**
   * Scrolls the element into the viewport.
   *
   * Primary: calls element.scrollIntoView() on the real DOM node via the content
   * script message. This handles nested scroll containers, sticky ancestors and
   * pages that override window.scrollTo.
   *
   * Fallback: if the content-script path fails (e.g. element not yet in
   * indexToElement map), falls back to window.scrollTo with calculated coords.
   */
  async _scrollToElement(el, pageState, tabId) {
    const ok = await this._bridge.scrollElementIntoView(tabId, el.index);
    if (!ok) {
      // Fallback: pixel-exact window scroll
      const absX = (pageState.scrollX || 0) + el.rect.x + el.rect.w / 2;
      const absY = (pageState.scrollY || 0) + el.rect.y + el.rect.h / 2;
      const targetScrollX = Math.max(0, absX - pageState.viewportWidth  / 2);
      const targetScrollY = Math.max(0, absY - pageState.viewportHeight / 2);
      await this._bridge.scrollToPosition(tabId, targetScrollX, targetScrollY);
    }
  }

  /**
   * Applies human-like jitter to coordinates, avoiding the dead-zone at centre.
   */
  _jitterCoords(rect, cx, cy) {
    const padX = Math.max(3, Math.min(rect.w * 0.14, 12));
    const padY = Math.max(3, Math.min(rect.h * 0.18, 10));
    const deadX = Math.max(2, Math.min(8, rect.w * 0.1));
    const deadY = Math.max(2, Math.min(6, rect.h * 0.1));

    const randomBetween = (a, b) => a + Math.random() * (b - a);

    const jitterAxis = (min, max, center, dead, pad) => {
      const lo = [min + pad, center - dead];
      const hi = [center + dead, max - pad];
      const useLeft  = lo[1] > lo[0];
      const useRight = hi[1] > hi[0];
      if (useLeft && useRight) return Math.random() < 0.5
        ? randomBetween(lo[0], lo[1]) : randomBetween(hi[0], hi[1]);
      if (useLeft)  return randomBetween(lo[0], lo[1]);
      if (useRight) return randomBetween(hi[0], hi[1]);
      return center;
    };

    return {
      x: jitterAxis(rect.x, rect.x + rect.w, cx, deadX, padX),
      y: jitterAxis(rect.y, rect.y + rect.h, cy, deadY, padY),
    };
  }

  // ── misc helpers ───────────────────────────────────────────────────────────

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
