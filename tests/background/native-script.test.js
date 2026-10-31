import { jest } from '@jest/globals';
import { NativeScriptService, NativeScriptError } from '../../background/native-script.js';
import { InputControlBridge } from '../../background/input-control.js';
import { CdpInputControlBridge } from '../../../browser-agent-input-control/index.js';
import { validateScriptPlan, evaluateScriptValue, checkJSON } from '../../background/native-script-plan.js';

const literal = value => ({ kind: 'literal', value });
const ref = id => ({ kind: 'ref', id });
const plan = (steps = [], result = { kind: 'undefined' }) => ({ version: 1, steps, result });
const context = { screenX: 0, screenY: 0, outerHeight: 900, innerHeight: 800, outerWidth: 1000, innerWidth: 1000, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
const state = { context, width: 1000, height: 800, url: 'https://example.test/', visible: true, editable: true, x: 100, y: 100, scrollX: 0, scrollY: 0, pageWidth: 1000, pageHeight: 4000 };
const request = { tabId: 7, kind: 'expression', source: 'document.title' };
function setup(p = plan(), inputControl = Object.assign(new InputControlBridge(), {
  execute: jest.fn().mockResolvedValue({ status: 'ok' }), abort: jest.fn(),
})) {
  const llm = { complete: jest.fn().mockResolvedValue(JSON.stringify(p)) };
  const page = {
    snapshot: jest.fn().mockResolvedValue(state), target: jest.fn().mockResolvedValue(state),
    read: jest.fn().mockResolvedValue('Example'), assertActive: jest.fn().mockResolvedValue(undefined),
  };
  return { llm, inputControl, page, service: new NativeScriptService({ llm, inputControl, page }) };
}
const read = { op: 'read', id: 'title', property: 'title' };

it('requires an AI provider and defaults to Python without connecting at construction', () => {
  expect(() => new NativeScriptService()).toThrow(NativeScriptError);
  const service = new NativeScriptService({ llm: { complete() {} } });
  expect(service._inputControl).toBeInstanceOf(InputControlBridge);
  expect(chrome.runtime.connectNative).not.toHaveBeenCalled();
});

it.each([null, {}, { execute() {} }])('rejects incomplete input interfaces: %j', inputControl => {
  expect(() => new NativeScriptService({ llm: { complete() {} }, inputControl }))
    .toThrow('Input control must implement execute, abort and disconnect');
});

it.each(['execute', 'abort', 'disconnect'])('requires a callable %s on the trusted input interface', method => {
  const inputControl = { execute() {}, abort() {}, disconnect() {} };
  expect(() => new NativeScriptService({ llm: { complete() {} }, inputControl })).not.toThrow();
  delete inputControl[method];
  expect(() => new NativeScriptService({ llm: { complete() {} }, inputControl })).toThrow(NativeScriptError);
  inputControl[method] = true;
  expect(() => new NativeScriptService({ llm: { complete() {} }, inputControl })).toThrow(NativeScriptError);
});

it('translates click and key input through the actual CDP bridge without a native host', async () => {
  const connectNative = jest.spyOn(chrome.runtime, 'connectNative').mockImplementation(() => {
    throw new Error('No native host installed');
  });
  const transport = { send: jest.fn().mockResolvedValue({}), detach: jest.fn().mockResolvedValue(undefined), dispose: jest.fn() };
  const bridge = { getActiveTabId: jest.fn().mockResolvedValue(request.tabId) };
  const inputControl = new CdpInputControlBridge({ bridge, transport });
  const execute = jest.spyOn(inputControl, 'execute');
  const { service, page } = setup(plan([{ op: 'click', selector: '#button' }, { op: 'key', key: 'Enter' }]), inputControl);
  try {
    await expect(service.execute({ ...request, kind: 'program', source: "document.querySelector('#button').click(); /* Then press Enter. */" }))
      .resolves.toMatchObject({ type: 'undefined' });
    const calls = transport.send.mock.calls;
    expect(calls.every(([tabId]) => tabId === request.tabId)).toBe(true);
    expect(calls.filter(([, method, params]) => method === 'Input.dispatchMouseEvent' && params.type !== 'mouseMoved'))
      .toEqual([
        [7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1, buttons: 1 }],
        [7, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1, buttons: 0 }],
      ]);
    expect(calls.filter(([, method]) => method === 'Input.dispatchKeyEvent')).toEqual([
      [7, 'Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' })],
      [7, 'Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'Enter' })],
    ]);
    expect(calls.every(([, method]) => ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(method))).toBe(true);
    expect(execute.mock.calls).toEqual([
      ['mouse_move', { x: 100, y: 100, duration_ms: 150 }, context],
      ['mouse_click', { x: 100, y: 100, button: 'left', count: 1 }, context],
      ['press_key', { key: 'Enter', repeat: 1 }, context],
    ]);
    expect(bridge.getActiveTabId).toHaveBeenCalledTimes(3);
    expect(page.assertActive).toHaveBeenCalledTimes(3);
    expect(page.target).toHaveBeenCalledTimes(2);
    expect(connectNative).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  } finally {
    await inputControl.disconnect();
    connectNative.mockRestore();
  }
});

it.each(['inputControl', 'backend', 'page'])('rejects external %s injection before translation or input', async field => {
  const injected = { execute: jest.fn(), abort: jest.fn(), disconnect: jest.fn() };
  const { service, llm, page, inputControl } = setup(plan([{ op: 'key', key: 'Enter' }]));
  await expect(service.execute({ ...request, [field]: injected })).rejects.toMatchObject({ code: 'E_SCRIPT_REQUEST' });
  expect(llm.complete).not.toHaveBeenCalled();
  expect(page.snapshot).not.toHaveBeenCalled();
  expect(inputControl.execute).not.toHaveBeenCalled();
  expect(injected.execute).not.toHaveBeenCalled();
});

it('translates read-only source with the configured provider and returns normalized live values', async () => {
  const { service, llm, page, inputControl } = setup(plan([read], ref('title')));
  await expect(service.executeExternalScript(request)).resolves.toEqual({ value: 'Example', type: 'string', subtype: undefined });
  expect(llm.complete).toHaveBeenCalledWith(expect.objectContaining({
    messages: [{ role: 'user', content: JSON.stringify({ kind: 'expression', source: 'document.title', args: [] }) }], signal: expect.any(AbortSignal),
  }));
  expect(page.read).toHaveBeenCalledWith(7, read);
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it.each([
  [literal(null), { value: null, type: 'object', subtype: 'null' }],
  [literal([1, 2]), { value: [1, 2], type: 'object', subtype: 'array' }],
  [{ kind: 'undefined' }, { value: undefined, type: 'undefined', subtype: undefined }],
])('normalizes return types without predicting page results', async (result, expected) => {
  await expect(setup(plan([], result)).service.execute(request)).resolves.toEqual(expected);
});

it('uses native commands in order for replacement typing, hover, keys, wheel and pause', async () => {
  const { service, inputControl, page } = setup(plan([
    { op: 'type', selector: '#input', text: { kind: 'arg', index: 0 }, mode: 'replace' },
    { op: 'hover', selector: '#button' }, { op: 'key', key: 'Enter', repeat: 2 },
    { op: 'shortcut', keys: ['control', 's'] }, { op: 'scroll', deltaX: 1, deltaY: 200 }, { op: 'wait', ms: 10 },
  ]));
  await service.execute({ ...request, args: ['hello'] });
  expect(inputControl.execute.mock.calls.map(c => c[0])).toEqual(['mouse_move', 'mouse_click', 'press_shortcut', 'press_key', 'type', 'mouse_move', 'press_key', 'press_shortcut', 'scroll', 'pause']);
  expect(inputControl.execute).toHaveBeenCalledWith('type', { text: 'hello', wpm: 60 }, context);
  expect(inputControl.execute).toHaveBeenCalledWith('press_key', { key: 'Enter', repeat: 2 }, context);
  expect(page.assertActive).toHaveBeenCalledTimes(inputControl.execute.mock.calls.length);
  expect(page.snapshot.mock.calls.length).toBeGreaterThanOrEqual(inputControl.execute.mock.calls.length);
});

it('natively scrolls offscreen targets, re-resolves, then clicks', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'click', selector: '#below' }]));
  page.target.mockResolvedValueOnce({ ...state, visible: false, scroll: { x: 300, y: 200, deltaX: 0, deltaY: 30000 } });
  await service.execute(request);
  expect(inputControl.execute.mock.calls.map(c => c[0])).toEqual(['scroll', 'mouse_move', 'mouse_click']);
  expect(inputControl.execute.mock.calls[0][1].delta_y).toBe(1000);
  expect(page.target).toHaveBeenCalledTimes(3);
});

it('bounds scroll retries and does not click unreachable targets', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'click', selector: '#below' }]));
  page.target.mockResolvedValue({ ...state, visible: false, scroll: { x: 300, y: 200, deltaX: 0, deltaY: 50 } });
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_TARGET', stepIndex: 0 });
  expect(inputControl.execute).toHaveBeenCalledTimes(8);
  expect(inputControl.execute.mock.calls.every(c => c[0] === 'scroll')).toBe(true);
});

it('absolute scrollTo reads live offsets and document bounds, uses native wheel, and clamps to document', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'scrollTo', x: literal(0), y: literal(4000) }]));
  let offset = 0;
  page.snapshot.mockImplementation(async () => ({ ...state, scrollY: offset, context: { ...context, scrollY: offset } }));
  inputControl.execute.mockImplementation(async (command, params) => { if (command === 'scroll') offset += params.delta_y; });
  await service.execute(request);
  expect(offset).toBe(3200);
  expect(inputControl.execute.mock.calls.map(c => c[1].delta_y)).toEqual([1000, 1000, 1000, 200]);
});

it('fails inactive tabs before keyboard input and refreshes screen context each command', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'key', key: 'Enter' }]));
  page.assertActive.mockRejectedValue(new NativeScriptError('E_SCRIPT_TAB', 'inactive'));
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_TAB' });
  expect(inputControl.execute).not.toHaveBeenCalled();
  page.assertActive.mockResolvedValue(undefined);
  page.snapshot.mockResolvedValue({ ...state, context: { ...context, screenX: 500 } });
  await service.execute(request);
  expect(inputControl.execute.mock.calls[0][2].screenX).toBe(500);
});

it('stops without any fallback when native input fails', async () => {
  const { service, inputControl } = setup(plan([{ op: 'click', selector: '#button' }, { op: 'key', key: 'Enter' }]));
  const cause = new Error('native disconnected');
  inputControl.execute.mockRejectedValue(cause);
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_EXECUTION', cause });
  expect(inputControl.execute).toHaveBeenCalledTimes(1);
});

it('rejects page changes and out-of-bounds coordinates before desktop input', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'click', selector: '#button' }]));
  page.target.mockResolvedValue({ ...state, url: 'https://old.test/' });
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_TARGET' });
  page.target.mockResolvedValue({ ...state, x: -100 });
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_TARGET' });
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it.each([
  { ...plan([{ op: 'click', selector: '#button' }, { op: 'eval', source: 'alert(1)' }]) },
  { ...plan([{ op: 'click', selector: '#button', code: 'unsafe' }]) },
  { ...plan([{ op: 'read', id: 'x', selector: 'body', property: 'constructor' }]) },
  { ...plan([{ op: 'scroll', deltaX: 0, deltaY: Infinity }]) },
  { ...plan([{ op: 'key', key: 'Enter', repeat: 0 }]) },
  { ...plan([], ref('missing')) },
  { ...plan([{ op: 'mouse_down', selector: 'body' }]) },
])('validates the whole plan before page or native work: %j', async p => {
  const { service, page, inputControl } = setup(p);
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_PLAN' });
  expect(page.snapshot).not.toHaveBeenCalled();
  expect(page.target).not.toHaveBeenCalled();
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it.each(['return document.title', '```json\n{}\n```', '{"version":1} trailing', '{} {}'])('rejects non-JSON/ambiguous AI output, never runs it', async raw => {
  const { service, llm, inputControl } = setup();
  llm.complete.mockResolvedValue(raw);
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_PLAN' });
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it('explicitly rejects unsupported scripts without exposing source/model text', async () => {
  const { service, inputControl } = setup({ unsupported: 'secret source text' });
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_UNSUPPORTED', message: expect.not.stringContaining('secret') });
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it.each([{ awaitPromise: false }, { returnByValue: false }, { world: 'MAIN' }, { timeoutMs: 0 }, { kind: 'script' }, { args: [undefined] }])('rejects unsupported or malformed requests before AI: %j', async extra => {
  const { service, llm } = setup();
  await expect(service.execute({ ...request, ...extra })).rejects.toBeInstanceOf(NativeScriptError);
  expect(llm.complete).not.toHaveBeenCalled();
});

it('captures console values and typed object/array results', async () => {
  const { service } = setup(plan([read, { op: 'log', level: 'info', values: [ref('title')] }], {
    kind: 'object', entries: { title: ref('title'), args: { kind: 'array', items: [{ kind: 'arg', index: 0 }] } },
  }));
  await expect(service.execute({ ...request, captureConsole: true, args: [42] })).resolves.toMatchObject({ value: { title: 'Example', args: [42] }, console_entries: [{ level: 'info', args: ['Example'] }] });
});

it('returns live read arithmetic and JSON field access without JavaScript execution', async () => {
  const result = { kind: 'binary', operator: '*', left: { kind: 'field', value: ref('box'), key: 'width' }, right: literal(2) };
  const p = plan([{ op: 'read', id: 'box', selector: '#x', property: 'rect' }], result);
  const { service, page } = setup(p);
  page.read.mockResolvedValue({ x: 0, y: 0, width: 45, height: 20 });
  await expect(service.execute(request)).resolves.toMatchObject({ value: 90, type: 'number' });
});

it('rejects prototype access, getters, cycles, nonfinite arithmetic and excessively deep values', () => {
  expect(() => checkJSON(JSON.parse('{"__proto__":{}}'))).toThrow();
  expect(() => checkJSON({ get x() { throw new Error('getter ran'); } })).toThrow(/accessors/);
  const cycle = {}; cycle.self = cycle;
  expect(() => checkJSON(cycle)).toThrow();
  let nested = {}; for (let i = 0; i < 22; i++) nested = { nested };
  expect(() => checkJSON(nested)).toThrow();
  expect(() => evaluateScriptValue({ kind: 'binary', operator: '/', left: literal(1), right: literal(0) }, new Map(), [])).toThrow(/non-finite/);
  expect(() => validateScriptPlan(plan([], { kind: 'field', value: literal({}), key: 'constructor' }))).toThrow();
});

it.each([[false, 'control', 'press_key', { key: 'End' }], [true, 'control', 'press_shortcut', { keys: ['control', 'End'] }], [true, 'command', 'press_shortcut', { keys: ['command', 'ArrowDown'] }]])('positions the caret at the end for append: multiline=%s platform=%s', async (multiline, primaryModifier, command, params) => {
  const { service, page, inputControl } = setup(plan([{ op: 'type', selector: '#input', text: literal('tail'), mode: 'append' }]));
  page.target.mockResolvedValue({ ...state, multiline, primaryModifier });
  await service.execute(request);
  expect(inputControl.execute.mock.calls.map(c => c[0])).toEqual(['mouse_move', 'mouse_click', command, 'type']);
  expect(inputControl.execute.mock.calls[2].slice(0, 2)).toEqual([command, params]);
});

it('re-resolves coordinates and hit-testing after hover before clicking', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'click', selector: '#button' }]));
  page.target.mockResolvedValueOnce(state).mockResolvedValue({ ...state, x: 500, y: 300 });
  await service.execute(request);
  expect(inputControl.execute.mock.calls[0][1]).toMatchObject({ x: 100, y: 100 });
  expect(inputControl.execute.mock.calls[1][1]).toMatchObject({ x: 500, y: 300 });
  expect(page.target).toHaveBeenCalledTimes(2);
});

it('does not click when hover hides or covers the target', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'click', selector: '#button' }]));
  page.target.mockResolvedValueOnce(state).mockRejectedValue(new Error('Target obscured'));
  await expect(service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_EXECUTION' });
  expect(inputControl.execute.mock.calls.map(c => c[0])).toEqual(['mouse_move']);
});

it('checks cancellation after translation and immediately before native commands', async () => {
  const { service, page, inputControl } = setup(plan([{ op: 'key', key: 'Enter' }]));
  const controller = new AbortController();
  page.assertActive.mockImplementation(async () => { controller.abort(); });
  await expect(service.execute({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'E_SCRIPT_ABORTED' });
  expect(inputControl.execute).not.toHaveBeenCalled();
});

it('honors already-aborted requests without calling AI', async () => {
  const { service, llm } = setup();
  const controller = new AbortController(); controller.abort();
  await expect(service.execute({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'E_SCRIPT_ABORTED' });
  expect(llm.complete).not.toHaveBeenCalled();
});

it('aborts during AI, globally locks translation, and releases the lock even when provider ignores signal', async () => {
  const a = setup(), b = setup();
  const controller = new AbortController();
  let finish;
  a.llm.complete.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = a.service.execute({ ...request, signal: controller.signal });
  await expect(b.service.execute(request)).rejects.toMatchObject({ code: 'E_SCRIPT_BUSY' });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'E_SCRIPT_ABORTED' });
  await expect(b.service.execute(request)).resolves.toMatchObject({ type: 'undefined' });
  finish(JSON.stringify(plan([{ op: 'click', selector: 'body' }])));
  await Promise.resolve();
  expect(a.inputControl.execute).not.toHaveBeenCalled();
});

it('aborts the native host mid-input and never executes subsequent commands', async () => {
  const { service, inputControl } = setup(plan([{ op: 'key', key: 'Enter' }, { op: 'key', key: 'Tab' }]));
  const controller = new AbortController();
  inputControl.execute.mockImplementation(() => new Promise(() => {}));
  const pending = service.execute({ ...request, signal: controller.signal });
  // Flush provider and geometry microtasks without timers.
  for (let i = 0; i < 30 && !inputControl.execute.mock.calls.length; i++) await Promise.resolve();
  expect(inputControl.execute).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'E_SCRIPT_ABORTED' });
  expect(inputControl.abort).toHaveBeenCalledTimes(1);
  expect(inputControl.execute).toHaveBeenCalledTimes(1);
});

it.each(['reject', 'throw'])('preserves cancellation when input abort fails: %s', async failure => {
  const { service, inputControl } = setup(plan([{ op: 'key', key: 'Enter' }, { op: 'key', key: 'Tab' }]));
  const controller = new AbortController();
  const cause = new Error('abort failed');
  inputControl.abort.mockImplementation(() => {
    if (failure === 'throw') throw cause;
    return Promise.reject(cause);
  });
  inputControl.execute.mockImplementation(() => {
    controller.abort();
    return new Promise(() => {});
  });
  await expect(service.execute({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'E_SCRIPT_ABORTED' });
  expect(inputControl.abort).toHaveBeenCalledTimes(1);
  expect(inputControl.execute).toHaveBeenCalledTimes(1);
  // Let rejected abort promises settle; Jest will fail on unhandled rejections.
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(setup().service.execute(request)).resolves.toMatchObject({ type: 'undefined' });
});

it('times out translation and releases the process-wide lock', async () => {
  jest.useFakeTimers();
  try {
    const { service, llm } = setup();
    llm.complete.mockImplementation(() => new Promise(() => {}));
    const pending = service.execute({ ...request, timeoutMs: 20 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'E_SCRIPT_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(21);
    await assertion;
    await expect(setup().service.execute(request)).resolves.toMatchObject({ type: 'undefined' });
  } finally { jest.useRealTimers(); }
});
