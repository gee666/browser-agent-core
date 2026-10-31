import { InputControlBridge } from './input-control.js';
import { NativeScriptPageBridge } from './native-script-page.js';
import { NativeScriptError, SCRIPT_LIMITS, checkJSON, fail, validateScriptPlan, evaluateScriptValue, NATIVE_SCRIPT_PROMPT } from './native-script-plan.js';

export { NativeScriptError } from './native-script-plan.js';

// Native input is process-wide. Include translation in this lock so an old
// translation cannot execute later against a page changed by another request.
let busy = false;
const allowedRequest = new Set(['tabId', 'kind', 'source', 'args', 'awaitPromise', 'returnByValue', 'captureConsole', 'timeoutMs', 'signal']);

export class NativeScriptService {
  constructor({ llm, inputControl = new InputControlBridge(), page = new NativeScriptPageBridge() } = {}) {
    if (!llm || typeof llm.complete !== 'function') fail('E_SCRIPT_CONFIG', 'A configured AI provider is required');
    if (!(inputControl instanceof InputControlBridge)) fail('E_SCRIPT_CONFIG', 'Native scripts require the python InputControlBridge');
    this._llm = llm;
    this._inputControl = inputControl;
    this._page = page;
  }

  execute(request) { return this.executeExternalScript(request); }

  /** Translate every external source, validate the complete plan, then interpret it. */
  async executeExternalScript(request) {
    if (!request || typeof request !== 'object' || Object.keys(request).some(k => !allowedRequest.has(k))) fail('E_SCRIPT_REQUEST', 'Unknown or invalid script request');
    const { tabId, kind, source, signal, captureConsole = false } = request;
    if (!Number.isInteger(tabId) || tabId < 0 || !['expression', 'program'].includes(kind)
        || typeof source !== 'string' || !source.trim() || source.length > SCRIPT_LIMITS.source) fail('E_SCRIPT_REQUEST', 'Invalid tab, source or script kind');
    for (const flag of ['awaitPromise', 'returnByValue', 'captureConsole']) {
      if (request[flag] !== undefined && typeof request[flag] !== 'boolean') fail('E_SCRIPT_REQUEST', 'Script flags must be boolean');
    }
    if (request.awaitPromise === false || request.returnByValue === false) fail('E_SCRIPT_UNSUPPORTED', 'Detached execution and remote object handles are not supported');
    const args = request.args ?? [];
    if (!Array.isArray(args)) fail('E_SCRIPT_REQUEST', 'Script args must be a JSON array');
    checkJSON(args, SCRIPT_LIMITS.args);
    // Snapshot arguments so caller mutation cannot change a validated request.
    const values = JSON.parse(JSON.stringify(args));
    const timeoutMs = request.timeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail('E_SCRIPT_REQUEST', 'timeoutMs must be an integer from 1 to 300000');
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('E_SCRIPT_REQUEST', 'Invalid AbortSignal');
    if (signal?.aborted) fail('E_SCRIPT_ABORTED', 'Script request aborted');
    if (busy) fail('E_SCRIPT_BUSY', 'Another native script request is in progress');
    busy = true;
    const controller = new AbortController();
    let nativeActive = false;
    let cancelError;
    let timer;
    const cancel = (code, message) => {
      if (controller.signal.aborted) return;
      cancelError = new NativeScriptError(code, message);
      controller.abort();
      if (nativeActive) this._inputControl.abort();
    };
    const onAbort = () => cancel('E_SCRIPT_ABORTED', 'Script request aborted');
    const check = () => { if (controller.signal.aborted) throw cancelError; };
    const wait = async promise => {
      // The operation may have synchronously triggered cancellation before this
      // helper receives its promise. Still observe any later rejection.
      const pending = Promise.resolve(promise);
      if (controller.signal.aborted) { pending.catch(() => {}); check(); }
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(cancelError);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try { const value = await Promise.race([pending, cancelled]); check(); return value; }
      finally { controller.signal.removeEventListener('abort', abort); }
    };
    const native = async (command, params, snapshot) => {
      check();
      // Refresh native screen context for EVERY command, including keyboard-only
      // steps and later commands in a type sequence. Never reuse cached offsets.
      const fresh = await wait(this._page.snapshot(tabId));
      await wait(this._page.assertActive(tabId));
      check();
      if (snapshot?.url !== undefined && fresh.url !== snapshot.url) fail('E_SCRIPT_TARGET', 'Page changed before native input');
      snapshot = fresh;
      if (!snapshot?.context || !Number.isFinite(snapshot.width) || !Number.isFinite(snapshot.height) || snapshot.width < 4 || snapshot.height < 4) fail('E_SCRIPT_PAGE', 'Invalid page context');
      for (const key of ['screenX', 'screenY', 'outerHeight', 'innerHeight', 'outerWidth', 'innerWidth', 'devicePixelRatio', 'scrollX', 'scrollY']) {
        if (!Number.isFinite(snapshot.context[key])) fail('E_SCRIPT_PAGE', 'Invalid native screen context');
      }
      if (snapshot.context.devicePixelRatio <= 0) fail('E_SCRIPT_PAGE', 'Invalid native scale');
      if ('x' in params && (!Number.isFinite(params.x) || !Number.isFinite(params.y) || params.x < 1 || params.y < 1 || params.x >= snapshot.width - 1 || params.y >= snapshot.height - 1)) fail('E_SCRIPT_TARGET', 'Native coordinates are outside the viewport');
      nativeActive = true;
      try { return await wait(this._inputControl.execute(command, params, snapshot.context)); }
      finally { nativeActive = false; }
    };
    const snapshot = () => { check(); return wait(this._page.snapshot(tabId)); };
    const target = async selector => {
      let url;
      for (let attempt = 0; attempt <= SCRIPT_LIMITS.scrolls; attempt++) {
        check();
        const state = await wait(this._page.target(tabId, selector));
        if (url !== undefined && state.url !== url) fail('E_SCRIPT_TARGET', 'Page changed while resolving target');
        url = state.url;
        if (state.visible) return state;
        if (attempt === SCRIPT_LIMITS.scrolls || !state.scroll) break;
        const { x, y, deltaX, deltaY } = state.scroll;
        if (![x, y, deltaX, deltaY].every(Number.isFinite) || (!deltaX && !deltaY)) break;
        await native('scroll', { x, y, delta_x: Math.round(Math.max(-1000, Math.min(1000, deltaX))), delta_y: Math.round(Math.max(-1000, Math.min(1000, deltaY))), duration_ms: 300 }, state);
        await wait(new Promise(resolve => setTimeout(resolve, 100)));
      }
      fail('E_SCRIPT_TARGET', 'Target is not reachable by native scrolling');
    };
    const click = async (selector, state, { button = 'left', count = 1, editable = false } = {}) => {
      await native('mouse_move', { x: state.x, y: state.y, duration_ms: 150 }, state);
      // Hover can open an overlay or move the target. Resolve and hit-test again
      // after moving, not merely refresh the viewport/screen context.
      const fresh = await target(selector);
      if (fresh.url !== state.url) fail('E_SCRIPT_TARGET', 'Page changed after pointer movement');
      if (editable && !fresh.editable) fail('E_SCRIPT_TARGET', 'Typing target is no longer editable');
      await native('mouse_click', { x: fresh.x, y: fresh.y, button, count }, fresh);
      return fresh;
    };
    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel('E_SCRIPT_TIMEOUT', 'Script request timed out'), timeoutMs);
      check();
      const raw = await wait(this._llm.complete({
        system: NATIVE_SCRIPT_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ kind, source, args: values }) }],
        signal: controller.signal,
      }));
      check();
      if (typeof raw !== 'string' || raw.length > SCRIPT_LIMITS.response) fail('E_SCRIPT_PLAN', 'Invalid AI plan response');
      let plan;
      try { plan = JSON.parse(raw); }
      catch { fail('E_SCRIPT_PLAN', 'AI must return exactly one JSON plan'); }
      validateScriptPlan(plan, values); // Whole-plan validation precedes ALL page/native work.
      check();
      const refs = new Map();
      const consoleEntries = [];
      for (let i = 0; i < plan.steps.length; i++) {
        check();
        const step = plan.steps[i];
        try {
          if (step.op === 'read') {
            const value = await wait(this._page.read(tabId, step));
            if (value !== undefined) checkJSON(value);
            refs.set(step.id, value);
          } else if (step.op === 'log') {
            if (captureConsole) consoleEntries.push({ level: step.level, args: step.values.map(e => evaluateScriptValue(e, refs, values)) });
          } else if (step.op === 'wait') {
            await native('pause', { duration_ms: Math.round(step.ms) }, await snapshot());
          } else if (step.op === 'scroll') {
            const state = step.selector ? await target(step.selector) : await snapshot();
            await native('scroll', { x: step.selector ? state.x : Math.round(state.width / 2), y: step.selector ? state.y : Math.round(state.height / 2), delta_x: step.deltaX, delta_y: step.deltaY, duration_ms: 300 }, state);
          } else if (step.op === 'scrollTo') {
            const x = evaluateScriptValue(step.x, refs, values), y = evaluateScriptValue(step.y, refs, values);
            if (![x, y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000000)) fail('E_SCRIPT_PLAN', 'scrollTo requires bounded nonnegative coordinates');
            let reached = false;
            for (let attempt = 0; attempt <= SCRIPT_LIMITS.scrolls; attempt++) {
              const state = await snapshot();
              if (![state.pageWidth, state.pageHeight, state.scrollX, state.scrollY].every(Number.isFinite)) fail('E_SCRIPT_PAGE', 'Invalid scroll dimensions');
              const dx = Math.min(x, Math.max(0, state.pageWidth - state.width)) - state.scrollX;
              const dy = Math.min(y, Math.max(0, state.pageHeight - state.height)) - state.scrollY;
              if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) { reached = true; break; }
              if (attempt === SCRIPT_LIMITS.scrolls) break;
              await native('scroll', { x: Math.round(state.width / 2), y: Math.round(state.height / 2),
                delta_x: Math.round(Math.max(-1000, Math.min(1000, dx))), delta_y: Math.round(Math.max(-1000, Math.min(1000, dy))), duration_ms: 300 }, state);
              await wait(new Promise(resolve => setTimeout(resolve, 100)));
            }
            if (!reached) fail('E_SCRIPT_TARGET', 'Absolute scroll target was not reached');
          } else if (step.op === 'key' || step.op === 'shortcut') {
            if (step.selector) await click(step.selector, await target(step.selector));
            const state = await snapshot();
            await native(step.op === 'key' ? 'press_key' : 'press_shortcut', step.op === 'key' ? { key: step.key, repeat: step.repeat ?? 1 } : { keys: step.keys }, state);
          } else {
            const state = await target(step.selector);
            if (step.op === 'scrollIntoView') continue;
            if (step.op === 'hover') await native('mouse_move', { x: state.x, y: state.y, duration_ms: 150 }, state);
            if (step.op === 'click') await click(step.selector, state, { button: step.button, count: step.count });
            if (step.op === 'focus') await click(step.selector, state);
            if (step.op === 'type') {
              const text = evaluateScriptValue(step.text, refs, values);
              if (typeof text !== 'string' || text.length > SCRIPT_LIMITS.args) fail('E_SCRIPT_PLAN', 'Typing requires bounded text');
              if (!state.editable) fail('E_SCRIPT_TARGET', 'Typing requires an editable text control');
              const focused = await click(step.selector, state, { editable: true });
              const modifier = focused.primaryModifier === 'command' ? 'command' : 'control';
              if (step.mode === 'replace') {
                await native('press_shortcut', { keys: [modifier, 'a'] }, focused);
                await native('press_key', { key: 'Delete' }, focused);
              } else if (focused.multiline) {
                await native('press_shortcut', { keys: [modifier, modifier === 'command' ? 'ArrowDown' : 'End'] }, focused);
              } else {
                await native('press_key', { key: 'End' }, focused);
              }
              if (text) await native('type', { text, wpm: 60 }, focused);
            }
          }
        } catch (error) {
          if (error instanceof NativeScriptError) error.stepIndex = i;
          throw error;
        }
      }
      check();
      const value = evaluateScriptValue(plan.result, refs, values);
      if (value !== undefined) checkJSON(value);
      const result = { value, type: typeof value, subtype: value === null ? 'null' : Array.isArray(value) ? 'array' : undefined };
      if (captureConsole) { checkJSON(consoleEntries); result.console_entries = consoleEntries; }
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw cancelError;
      if (error instanceof NativeScriptError) throw error;
      // Native/Chrome/provider errors propagate as failures, never as a retry or fallback.
      const wrapped = new NativeScriptError('E_SCRIPT_EXECUTION', 'Native script translation or execution failed');
      wrapped.cause = error;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      busy = false;
    }
  }
}
