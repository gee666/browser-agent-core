/**
 * ActionExecutor — sequences and executes browser automation actions,
 * adding auto-scroll and auto-mouse_move where needed.
 */
export class ActionExecutor {
  /**
   * @param {{ bridge: object, inputControl: object }} options
   */
  constructor({ bridge, inputControl }) {
    this._bridge = bridge;
    this._inputControl = inputControl;
  }

  /**
   * Execute an ordered array of actions against the current page state.
   * @param {Array<{command: string, params: object}>} actions
   * @param {object} pageState
   */
  async execute(actions, pageState) {
    /** Track the last executed action for mouse_move dedup. */
    let lastExecuted = null;

    for (const action of actions) {
      const { command, params } = action;

      // ── navigate ──────────────────────────────────────────────────────────
      if (command === 'navigate') {
        await this._bridge.navigate(params.url);
        await this._bridge.waitForPageSettle();
        lastExecuted = action;
        continue;
      }

      // ── coordinate-based commands: auto-scroll if element is off-screen ──
      const coordCommands = new Set(['mouse_click', 'mouse_move', 'scroll']);
      if (coordCommands.has(command) && params.x != null && params.y != null) {
        const element = this._findElementByCoords(params.x, params.y, pageState.elements ?? []);
        if (element && element.inViewport === false) {
          const scrollAction = {
            command: 'scroll',
            params: {
              x: Math.round(pageState.viewportWidth / 2),
              y: Math.round(pageState.viewportHeight / 2),
              delta_x: 0,
              delta_y: Math.round(
                element.rect.y - pageState.viewportHeight / 2 + element.rect.height / 2
              ),
              duration_ms: 400,
            },
          };
          await this._inputControl.execute(scrollAction.command, scrollAction.params, pageState.context);
          await this._sleep(300);
        }
      }

      // ── mouse_click: auto-prepend mouse_move if not already there ─────────
      if (command === 'mouse_click') {
        const alreadyMoved =
          lastExecuted &&
          lastExecuted.command === 'mouse_move' &&
          lastExecuted.params.x === params.x &&
          lastExecuted.params.y === params.y;

        if (!alreadyMoved) {
          const moveAction = {
            command: 'mouse_move',
            params: { x: params.x, y: params.y, duration_ms: this._randomMs(300, 700) },
          };
          await this._inputControl.execute(moveAction.command, moveAction.params, pageState.context);
          lastExecuted = moveAction;
        }
      }

      // ── execute the action ────────────────────────────────────────────────
      await this._inputControl.execute(command, params, pageState.context);
      lastExecuted = action;

      // ── inter-action pause ────────────────────────────────────────────────
      await this._sleep(this._randomMs(80, 180));

      if (command === 'type') {
        await this._sleep(this._randomMs(100, 250));
      }
    }
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /**
   * Returns a random integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  _randomMs(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Finds the element whose centre is closest to (x, y).
   * @param {number} x
   * @param {number} y
   * @param {Array<object>} elements
   * @returns {object|null}
   */
  _findElementByCoords(x, y, elements) {
    if (!elements || elements.length === 0) return null;

    let closest = null;
    let minDist = Infinity;

    for (const el of elements) {
      const cx = el.rect.x + el.rect.width / 2;
      const cy = el.rect.y + el.rect.height / 2;
      const dist = Math.hypot(cx - x, cy - y);
      if (dist < minDist) {
        minDist = dist;
        closest = el;
      }
    }

    return closest;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
