/** @jest-environment node */
import { jest } from '@jest/globals';
import { AgentCore } from '../../background/agent.js';
import { JevError } from '../../background/jev.js';

const originalFetch = global.fetch;
const element = { index: 0, tag: 'input', attrs: { placeholder: 'Search' }, text: 'Search', rect: { x: 100, y: 100, w: 150, h: 30 }, inViewport: true };
const page = { url: 'https://example.com/?token=secret', title: 'Fixture', domText: '[0]<input placeholder=Search>', elements: [element], viewportWidth: 1000, viewportHeight: 700, context: {} };
const shot = 'data:image/png;base64,YQ==';
function setup(options = {}) {
  const bridge = { getActiveTabId: jest.fn().mockResolvedValue(1), getPageState: jest.fn().mockResolvedValue(page), sendStatus: jest.fn(), takeScreenshot: jest.fn().mockResolvedValue(shot), waitForPageSettle: jest.fn().mockResolvedValue() };
  const executor = { execute: jest.fn().mockResolvedValue() };
  const llm = { complete: jest.fn().mockResolvedValue('{"success":true,"message":"Observed result"}') };
  const helperLlm = { complete: jest.fn().mockResolvedValue('{"text":"hello"}') };
  const debugLog = jest.fn();
  const onDiscovery = jest.fn();
  const agent = new AgentCore({ bridge, executor, llm, helperLlm, debugLog, onDiscovery, decisionMode: 'jev', maxIterations: 1, ...options });
  agent._sleep = jest.fn().mockResolvedValue();
  agent._compressScreenshot = jest.fn().mockImplementation(raw => Promise.resolve(raw));
  return { agent, bridge, executor, llm, helperLlm, debugLog, onDiscovery };
}
function choices(...pairs) {
  let i = 0;
  global.fetch.mockImplementation(async () => ({ ok: true, json: async () => {
    const [action, target = 'NONE'] = pairs[Math.min(i++, pairs.length - 1)];
    return { answers: { action: { choice: action }, [`target_${action}`]: { choice: target } } };
  } }));
}
const bodies = () => global.fetch.mock.calls.map(([, request]) => JSON.parse(request.body));
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test('text-only classification clicks through existing executor with no helper or screenshot', async () => {
  choices(['CLICK', 'E_0']);
  const { agent, bridge, executor, helperLlm, llm } = setup({ useVision: true });
  await agent.run('Click Search');
  expect(executor.execute).toHaveBeenCalledWith({ click: { index: 0 } }, page);
  expect(bridge.takeScreenshot).not.toHaveBeenCalled();
  expect(helperLlm.complete).not.toHaveBeenCalled();
  expect(llm.complete).not.toHaveBeenCalled();
  expect(bodies()[0].images).toBeUndefined();
  expect(bodies()[0].questions.action.criteria.SCREENSHOT_NEEDED).toBeDefined();
  expect(bodies()[0].questions.target_CLICK.criteria.TARGET_NOT_LISTED).toBeUndefined();
});

test('typing helper supplies text only and raw staged turns are not debug logged', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, executor, helperLlm, debugLog } = setup();
  await agent.run('Type hello in Search');
  expect(executor.execute).toHaveBeenCalledWith({ type: { index: 0, text: 'hello' } }, page);
  expect(helperLlm.complete.mock.calls[0][0].responseSchema.required).toEqual(['text']);
  expect(agent._history[0].actionResult).not.toContain('hello');
  expect(agent._recentActions[0].actionStr).not.toContain('hello');
  expect(debugLog).not.toHaveBeenCalled();
});

test('helper defaults to normal LLM and rejects target-changing output', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, llm, executor } = setup({ helperLlm: undefined });
  llm.complete.mockResolvedValueOnce('{"text":"hello","index":999}').mockResolvedValueOnce('{"text":"hello"}');
  await agent.run('Type hello');
  expect(llm.complete).toHaveBeenCalledTimes(2);
  expect(executor.execute).toHaveBeenCalledWith({ type: { index: 0, text: 'hello' } }, page);
});

test('screenshot escalation uses same context, top-level images, and cannot escalate again', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'E_0']);
  const { agent, bridge } = setup();
  await agent.run('Click the visually indicated target');
  expect(bridge.takeScreenshot).toHaveBeenCalledTimes(1);
  const [text, visual] = bodies();
  expect(visual.state).toBe(text.state);
  expect(visual.images).toEqual([shot]);
  expect(visual.questions.action.criteria.SCREENSHOT_NEEDED).toBeUndefined();
  expect(visual.questions.target_CLICK.criteria.TARGET_NOT_LISTED).toBeDefined();
});

test('failed screenshot capture still has a bounded second stage', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'E_0']);
  const { agent, bridge } = setup(); bridge.takeScreenshot.mockResolvedValue(null);
  await agent.run('click');
  expect(bodies()[1].images).toBeUndefined();
  expect(bodies()[1].state).toContain('Screenshot capture unavailable');
});

test('fallback receives identical choices/context and screenshot, validates locally with one retry', async () => {
  choices(['SCREENSHOT_NEEDED'], ['UNLISTED']);
  const { agent, llm, executor } = setup();
  llm.complete.mockResolvedValueOnce('{"action":"CLICK","target_CLICK":"E_99"}').mockResolvedValueOnce('{"action":"CLICK","target_CLICK":"E_0"}');
  await agent.run('Click target');
  expect(llm.complete).toHaveBeenCalledTimes(2);
  const call = llm.complete.mock.calls[0][0];
  expect(call.screenshot).toBe(shot);
  const fallback = JSON.parse(call.messages[0].content);
  expect(fallback.state).toBe(bodies()[1].state);
  expect(fallback.questions).toEqual(bodies()[1].questions);
  expect(call.responseSchema.properties.target_CLICK.enum).toContain('E_0');
  expect(call.responseSchema.properties.action.enum).not.toContain('SCREENSHOT_NEEDED');
  expect(executor.execute).toHaveBeenCalledTimes(1);
});

test('provider error falls back; missing selected operation head does not reach executor', async () => {
  global.fetch.mockRejectedValue(new Error('private-key'));
  const { agent, llm, executor } = setup();
  llm.complete.mockResolvedValue('{"action":"CLICK","target_TYPE":"E_0"}');
  await expect(agent.run('click')).rejects.toThrow('Normal LLM fallback returned invalid choices');
  expect(llm.complete).toHaveBeenCalledTimes(2);
  expect(executor.execute).not.toHaveBeenCalled();
});

test('disabled fallback surfaces safe failure', async () => {
  global.fetch.mockRejectedValue(new Error('private-key'));
  const { agent, llm } = setup({ decisionConfig: { fallbackEnabled: false } });
  await expect(agent.run('click')).rejects.toThrow('Jev request failed');
  expect(llm.complete).not.toHaveBeenCalled();
});

test('BLOCKED is not a fallback trigger and does not verify a failed task', async () => {
  choices(['BLOCKED']);
  const { agent, helperLlm, llm, bridge } = setup({ verifyDone: true });
  helperLlm.complete.mockResolvedValue('{"success":false,"message":"CAPTCHA requires user input"}');
  expect(await agent.run('do task')).toBe('CAPTCHA requires user input');
  expect(llm.complete).not.toHaveBeenCalled();
  expect(bridge.sendStatus.mock.calls.at(-1)[0]).toMatchObject({ state: 'done', message: 'CAPTCHA requires user input' });
});

test('DONE delegates factual message and preserves opt-in verification', async () => {
  choices(['DONE']);
  const { agent, helperLlm, llm, debugLog } = setup({ verifyDone: true });
  helperLlm.complete.mockResolvedValue('{"success":true,"message":"Observed result"}');
  llm.complete.mockResolvedValue('{"verified":true,"message":"Verified result"}');
  expect(await agent.run('read result')).toBe('Verified result');
  expect(llm.complete).toHaveBeenCalledTimes(1);
  expect(debugLog).not.toHaveBeenCalled();
});

test('helper failure and invalid JSON are bounded and never invent text', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, helperLlm, executor } = setup();
  helperLlm.complete.mockResolvedValue('not JSON');
  await expect(agent.run('type')).rejects.toThrow('Decision helper returned invalid parameters');
  expect(helperLlm.complete).toHaveBeenCalledTimes(2);
  expect(executor.execute).not.toHaveBeenCalled();
});

test('choice counts stay below API limit with visible targets preferred', () => {
  const { agent } = setup();
  const elements = Array.from({ length: 400 }, (_, index) => ({ ...element, index, inViewport: index >= 300 }));
  const questions = agent._stagedDecision.questions({ ...page, elements }, 'screenshot');
  expect(Object.keys(questions.target_CLICK.criteria)).toHaveLength(254);
  expect(questions.target_CLICK.criteria.E_399).toBeDefined();
  expect(questions.target_CLICK.criteria.E_299).toBeUndefined();
});

test('steers and short recent progress reach text classification', async () => {
  choices(['CLICK', 'E_0']);
  const { agent } = setup(); agent.addSteer('Use Search instead');
  await agent.run('click');
  expect(JSON.parse(bodies()[0].state).latestUserSteers).toEqual(['Use Search instead']);
});

test('missing target runs read-only investigation, registers coordinates, and records redacted execution result', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, helperLlm, executor, onDiscovery } = setup();
  const discovered = { ...element, index: 5, tag: 'div', text: 'Missed', attrs: { value: 'private-value' } };
  const discoveredPage = { ...page, elements: [...page.elements, discovered] };
  bridge.inspectDOM = jest.fn().mockResolvedValue({ ok: true, url: page.url, elements: [{ locator: 'html > body > div', tag: 'div' }] });
  bridge.resolveDOMTarget = jest.fn().mockResolvedValue({ ok: true, index: 5, locator: 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)', pageState: discoveredPage });
  helperLlm.complete.mockResolvedValue('{"operation":"resolve","selector":"div","reason":"private-value"}');
  await agent.run('Find the missed target for private-value');
  expect(bridge.inspectDOM).toHaveBeenCalledWith(1, { selector: 'body', limit: 40 });
  expect(bridge.resolveDOMTarget).toHaveBeenCalledWith(1, { selector: 'div', expectedUrl: page.url });
  expect(executor.execute).toHaveBeenCalledWith({ click: { index: 5 } }, discoveredPage);
  const diagnostic = onDiscovery.mock.calls.at(-1)[0];
  expect(diagnostic).toMatchObject({ url: 'https://example.com/', screenshotCaptured: true, executionResult: 'executed', relevantDOM: { index: 5, tag: 'div' } });
  expect(JSON.stringify(onDiscovery.mock.calls)).not.toMatch(/private-value|token=secret|data:image/);
});

test('investigation is bounded and missing target ends as failure, not invented success', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, helperLlm, executor, onDiscovery } = setup();
  bridge.inspectDOM = jest.fn().mockResolvedValue({ ok: true, url: page.url, elements: [] });
  bridge.resolveDOMTarget = jest.fn();
  helperLlm.complete.mockResolvedValue('{"operation":"inspect","selector":"div","reason":"look again"}');
  const result = await agent.run('click missed target');
  expect(result).toContain('could not be resolved');
  expect(bridge.inspectDOM).toHaveBeenCalledTimes(3);
  expect(helperLlm.complete).toHaveBeenCalledTimes(3);
  expect(executor.execute).not.toHaveBeenCalled();
  expect(onDiscovery.mock.calls.at(-1)[0].executionResult).toBe('target unresolved');
});

test('stale page or bridge error ends investigation without synthetic input', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, helperLlm, executor } = setup();
  bridge.inspectDOM = jest.fn().mockResolvedValue({ ok: true, url: 'https://different.com/', elements: [] });
  bridge.resolveDOMTarget = jest.fn();
  expect(await agent.run('click missed target')).toContain('could not be resolved');
  expect(helperLlm.complete).not.toHaveBeenCalled();
  expect(executor.execute).not.toHaveBeenCalled();
});

test('diagnostic callback failure cannot break a resolved action', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, helperLlm, executor, onDiscovery } = setup();
  bridge.inspectDOM = jest.fn().mockResolvedValue({ ok: true, url: page.url, elements: [] });
  bridge.resolveDOMTarget = jest.fn().mockResolvedValue({ ok: true, index: 0, locator: 'html > body > input', pageState: page });
  helperLlm.complete.mockResolvedValue('{"operation":"resolve","selector":"input","reason":"found"}');
  onDiscovery.mockRejectedValue(new Error('logging unavailable'));
  await agent.run('click');
  expect(executor.execute).toHaveBeenCalledTimes(1);
});

test('stop cancels pending Jev call without fallback or execution', async () => {
  const { agent, executor, llm } = setup();
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  global.fetch.mockImplementation(() => { started(); return new Promise(() => {}); });
  const run = agent.run('click'); await requestStarted; agent.stop();
  expect(await run).toBeNull();
  expect(llm.complete).not.toHaveBeenCalled();
  expect(executor.execute).not.toHaveBeenCalled();
});

test('stop cancels pending helper call', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, executor, helperLlm } = setup();
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  helperLlm.complete.mockImplementation(() => { started(); return new Promise(() => {}); });
  const run = agent.run('type'); await requestStarted; agent.stop();
  expect(await run).toBeNull();
  expect(helperLlm.complete.mock.calls[0][0].signal.aborted).toBe(true);
  expect(executor.execute).not.toHaveBeenCalled();
});

test('helper request timeout is bounded even if provider ignores signal', async () => {
  jest.useFakeTimers(); choices(['TYPE', 'E_0']);
  const { agent, helperLlm, executor } = setup({ decisionConfig: { timeoutMs: 20 } });
  helperLlm.complete.mockImplementation(() => new Promise(() => {}));
  const run = agent.run('type');
  const rejection = expect(run).rejects.toThrow('Decision helper timed out');
  await jest.advanceTimersByTimeAsync(20); await rejection;
  expect(executor.execute).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('staged status omits tasks and typing text for both callbacks and persisted bridge status', async () => {
  choices(['TYPE', 'E_0']);
  const onStatus = jest.fn();
  const { agent, helperLlm, bridge, executor } = setup({ onStatus });
  helperLlm.complete.mockResolvedValue('{"text":"secret-to-type"}');
  await agent.run('Enter secret-to-type');
  expect(JSON.stringify(onStatus.mock.calls)).not.toContain('secret-to-type');
  expect(JSON.stringify(bridge.sendStatus.mock.calls)).not.toContain('secret-to-type');
  expect(executor.execute.mock.calls[0][0].type.text).toBe('secret-to-type');
});

test('steers persist across steps and reset between runs', async () => {
  choices(['CLICK', 'E_0'], ['TYPE', 'E_0']);
  const { agent, helperLlm } = setup({ maxIterations: 2 });
  agent.addSteer('Correction: search banana instead');
  await agent.run('Search apple');
  expect(JSON.parse(bodies()[1].state).latestUserSteers).toEqual(['Correction: search banana instead']);
  expect(helperLlm.complete.mock.calls[0][0].messages[0].content).toContain('Correction: search banana instead');
  global.fetch.mockClear(); choices(['CLICK', 'E_0']);
  await agent.run('Another task');
  expect(JSON.parse(bodies()[0].state).latestUserSteers).toEqual([]);
});

test('discovery diagnostics omit path credentials too', async () => {
  const { agent } = setup();
  const diagnostic = agent._stagedDecision.diagnostic({ ...page, url: 'https://example.com/reset/secret-token' }, shot);
  expect(diagnostic.url).toBe('https://example.com/reset/[redacted]');
  expect(JSON.stringify(diagnostic)).not.toContain('secret-token');
});

test('staged navigation status omits full URLs but executor receives the intended URL', async () => {
  choices(['NAVIGATE']);
  const onStatus = jest.fn();
  const { agent, helperLlm, bridge, executor } = setup({ onStatus });
  helperLlm.complete.mockResolvedValue('{"url":"https://target.test/reset/private-token?key=private-query"}');
  bridge.getPageState.mockResolvedValue({ ...page, url: 'https://example.com/invite/current-private-token?auth=current-private-query' });
  await agent.run('Navigate');
  expect(JSON.stringify(onStatus.mock.calls)).not.toMatch(/private-token|private-query/);
  expect(JSON.stringify(bridge.sendStatus.mock.calls)).not.toMatch(/private-token|private-query/);
  expect(executor.execute.mock.calls[0][0].navigate.url).toBe('https://target.test/reset/private-token?key=private-query');
});

test('observed values survive navigation in private classifier and completion-helper context', async () => {
  choices(['NAVIGATE'], ['DONE']);
  const { agent, helperLlm, bridge, onDiscovery } = setup({ maxIterations: 2 });
  const firstPage = { ...page, url: 'https://example.com/a', domText: 'Observed price on A: $125' };
  const secondPage = { ...page, url: 'https://example.com/b', domText: 'Observed price on B: $110' };
  bridge.getPageState.mockResolvedValueOnce(firstPage).mockResolvedValue(secondPage);
  helperLlm.complete.mockResolvedValueOnce('{"url":"https://example.com/b"}').mockResolvedValueOnce('{"success":true,"message":"A is $15 more expensive"}');
  expect(await agent.run('Compare prices on A and B')).toBe('A is $15 more expensive');
  const secondState = JSON.parse(bodies()[1].state);
  expect(secondState.priorObservations).toEqual([{ url: firstPage.url, title: firstPage.title, dom: firstPage.domText }]);
  expect(helperLlm.complete.mock.calls[1][0].messages[0].content).toContain('Observed price on A: $125');
  expect(onDiscovery).not.toHaveBeenCalled();
  expect(JSON.stringify(bridge.sendStatus.mock.calls)).not.toContain('Observed price on A');
});

test.each([
  ['SCROLL_UP', 'NONE', { scroll: { direction: 'up', amount: 'medium' } }],
  ['SCROLL_DOWN', 'NONE', { scroll: { direction: 'down', amount: 'medium' } }],
  ['SCROLL_ELEMENT_UP', 'E_0', { scroll_element: { index: 0, direction: 'up', amount: 'medium' } }],
  ['SCROLL_ELEMENT_DOWN', 'E_0', { scroll_element: { index: 0, direction: 'down', amount: 'medium' } }],
  ['WAIT', 'NONE', { wait: { seconds: 2 } }],
  ['SELECT_OPTION', 'E_0', { select_option: { index: 0, text: 'hello' } }],
])('maps %s to the unchanged semantic executor contract', async (action, target, expected) => {
  choices([action, target]);
  const { agent, executor } = setup();
  await agent.run('do action');
  expect(executor.execute).toHaveBeenCalledWith(expected, page);
});

test('loop detection distinguishes different typed text without retaining its plaintext', () => {
  const { agent } = setup();
  const a = agent._actionIdentity({ type: { index: 0, text: 'first value' } });
  const b = agent._actionIdentity({ type: { index: 0, text: 'second value' } });
  expect(a).not.toBe(b);
  expect(a).not.toContain('first value');
  agent._recentActions = [{ url: page.url, actionStr: a }, { url: page.url, actionStr: b }];
  expect(agent._detectLoop()).toBe(0);
  agent._recentActions.push({ url: page.url, actionStr: b });
  expect(agent._detectLoop()).toBe(1);
});

test('stop cancels pending read-only investigation before resolution or input', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, executor } = setup();
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  bridge.inspectDOM = jest.fn().mockImplementation(() => { started(); return new Promise(() => {}); });
  bridge.resolveDOMTarget = jest.fn();
  const run = agent.run('missed target'); await requestStarted; agent.stop();
  expect(await run).toBeNull();
  expect(bridge.resolveDOMTarget).not.toHaveBeenCalled();
  expect(executor.execute).not.toHaveBeenCalled();
});

test('independent heads normalize only the selected operation and ignore unrelated missing/unlisted targets', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: {
    action: { choice: 'CLICK' }, target_CLICK: { choice: 'E_0' },
    target_TYPE: { choice: 'NO_TARGET' }, target_SELECT_OPTION: { choice: 'UNLISTED_SECRET' },
  } }) });
  const { agent, executor, llm, bridge } = setup();
  await agent.run('Click');
  expect(executor.execute).toHaveBeenCalledWith({ click: { index: 0 } }, page);
  expect(llm.complete).not.toHaveBeenCalled();
  expect(bridge.takeScreenshot).not.toHaveBeenCalled();
  const offered = bodies()[0].questions;
  expect(Object.keys(offered)).toEqual(['action', 'target_CLICK', 'target_TYPE', 'target_SELECT_OPTION', 'target_SCROLL_ELEMENT_UP', 'target_SCROLL_ELEMENT_DOWN']);
  for (const [id, question] of Object.entries(offered)) {
    if (id === 'action') continue;
    expect(question.criteria.E_0).toBeDefined();
    expect(question.criteria.NONE).toBeUndefined();
    expect(question.instructions).toContain('Independently assume');
  }
});

test('non-indexed decisions require no target answers', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { action: { choice: 'WAIT' } } }) });
  const { agent, executor } = setup();
  await agent.run('wait');
  expect(executor.execute).toHaveBeenCalledWith({ wait: { seconds: 2 } }, page);
});

test('selected text NO_TARGET escalates rather than triggering inconsistent-pair fallback', async () => {
  choices(['TYPE', 'NO_TARGET'], ['TYPE', 'E_0']);
  const { agent, bridge, llm, executor } = setup();
  await agent.run('Type hello');
  expect(bridge.takeScreenshot).toHaveBeenCalledTimes(1);
  expect(llm.complete).not.toHaveBeenCalled();
  expect(executor.execute.mock.calls[0][0]).toEqual({ type: { index: 0, text: 'hello' } });
  expect(bodies()[1].questions.target_TYPE.criteria.NO_TARGET).toBeUndefined();
  expect(bodies()[1].questions.target_TYPE.criteria.TARGET_NOT_LISTED).toBeDefined();
});

test('fallback uses the same speculative heads and ignores unrelated missing answers', async () => {
  global.fetch.mockRejectedValue(new Error('provider-secret'));
  const { agent, llm, executor } = setup();
  llm.complete.mockResolvedValue('{"action":"CLICK","target_CLICK":"E_0","target_TYPE":"NO_TARGET","target_SELECT_OPTION":"INVALID_UNUSED"}');
  await agent.run('Click');
  expect(llm.complete).toHaveBeenCalledTimes(1);
  const call = llm.complete.mock.calls[0][0];
  expect(Object.keys(call.responseSchema.properties)).toEqual(Object.keys(bodies()[0].questions));
  expect(call.responseSchema.properties.target_CLICK.enum).toContain('NO_TARGET');
  expect(executor.execute.mock.calls[0][0]).toEqual({ click: { index: 0 } });
});

test('custom elements remain offered in every speculative operation head without semantic filtering', () => {
  const { agent } = setup();
  const questions = agent._stagedDecision.questions({ ...page, elements: [{ ...element, tag: 'div', attrs: {}, index: 9 }] }, 'text');
  for (const id of Object.keys(questions).filter(id => id !== 'action')) expect(questions[id].criteria.E_9).toBeDefined();
});

test.each(['null', '{"text":null}', '{}', '{"missing":true}', '{"text":"invented","missing":true}'])('incomplete typing helper %s blocks immediately without retry, invention or input', async raw => {
  choices(['TYPE', 'E_0']);
  const { agent, helperLlm, executor, bridge } = setup({ verifyDone: true });
  helperLlm.complete.mockResolvedValueOnce(raw).mockResolvedValue('{"text":"invented"}');
  expect(await agent.run('Enter required value')).toContain('Please provide it');
  expect(helperLlm.complete).toHaveBeenCalledTimes(1);
  expect(helperLlm.complete.mock.calls[0][0].responseSchema.properties.text.type).toEqual(['string', 'null']);
  expect(executor.execute).not.toHaveBeenCalled();
  expect(bridge.sendStatus.mock.calls.some(([status]) => status.plannedAction?.done?.success === false)).toBe(true);
});

test('empty typing string remains an explicit value, not a missing signal', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, helperLlm, executor } = setup(); helperLlm.complete.mockResolvedValue('{"text":""}');
  await agent.run('Clear this field');
  expect(executor.execute.mock.calls[0][0]).toEqual({ type: { index: 0, text: '' } });
});

test.each(['bridge', 'helper', 'executor'])('raw %s errors never escape a staged turn or its callbacks', async source => {
  choices([source === 'helper' ? 'TYPE' : 'CLICK', 'E_0']);
  const { agent, bridge, helperLlm, executor, debugLog, onDiscovery } = setup();
  const error = Object.assign(new Error('raw-private-error'), { body: 'private-body' });
  if (source === 'bridge') bridge.getPageState.mockRejectedValue(error);
  if (source === 'helper') helperLlm.complete.mockRejectedValue(error);
  if (source === 'executor') executor.execute.mockRejectedValue(error);
  let caught; try { await agent.run('Action'); } catch (e) { caught = e; }
  expect(caught).toBeDefined();
  expect(caught.message).not.toMatch(/raw-private-error|private-body/);
  expect(JSON.stringify(caught)).not.toMatch(/raw-private-error|private-body/);
  expect(JSON.stringify(bridge.sendStatus.mock.calls)).not.toMatch(/raw-private-error|private-body/);
  expect(JSON.stringify(onDiscovery.mock.calls)).not.toMatch(/raw-private-error|private-body/);
  expect(debugLog).not.toHaveBeenCalled();
});

test('resolved discovery reports retain sanitized path, original indices and structural ancestor context', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'TARGET_NOT_LISTED']);
  const { agent, bridge, helperLlm, onDiscovery } = setup({ decisionConfig: { apiKey: 'private-key' } });
  const fixturePage = { ...page, url: 'https://user:password@example.com/d/dashboard/view?token=secret#private' };
  bridge.getPageState.mockResolvedValue(fixturePage);
  bridge.inspectDOM = jest.fn().mockResolvedValue({ ok: true, url: fixturePage.url, elements: [] });
  const locator = 'html:nth-child(1) > body:nth-child(2) > div:nth-child(1)';
  const domContext = { target: { tag: 'div', index: 0, locator, attrs: { role: 'button', 'aria-label': 'raw-secret', value: 'private-key' } },
    ancestors: [{ tag: 'section', attrs: { role: 'region', id: 'raw-secret' }, childElementCount: 3 }],
    children: [{ tag: 'svg', attrs: {} }] };
  bridge.resolveDOMTarget = jest.fn().mockResolvedValue({ ok: true, index: 0, locator, domContext, pageState: fixturePage });
  helperLlm.complete.mockResolvedValue('{"operation":"resolve","selector":"div","reason":"raw-secret"}');
  await agent.run('Click missing target');
  const report = onDiscovery.mock.calls.at(-1)[0];
  expect(report.url).toBe('https://example.com/d/dashboard/view');
  expect(report.originalListedIndices).toEqual([0]);
  expect(report.originalListedCount).toBe(1); expect(report.originalElementCount).toBe(1);
  expect(report.locator).toBe(locator);
  expect(report.relevantDOM.excerpt).toContain('<section role="region">');
  expect(report.relevantDOM.excerpt).toContain('<div role="button">');
  expect(report.relevantDOM.ancestors[0].childElementCount).toBe(3);
  expect(report.screenshotSaved).toBe(false); expect(report.screenshotPrivacy).toContain('pixel redaction');
  expect(JSON.stringify(onDiscovery.mock.calls)).not.toMatch(/raw-secret|private-key|user:password|token=secret|#private|data:image/);
});

test.each(['helper', 'executor'])('even JevError-shaped raw %s failures are sanitized and reconstructed', async source => {
  choices([source === 'helper' ? 'TYPE' : 'CLICK', 'E_0']);
  const { agent, helperLlm, executor } = setup();
  const error = Object.assign(new JevError('raw-private-error'), { body: 'private-body' });
  if (source === 'helper') helperLlm.complete.mockRejectedValue(error);
  else executor.execute.mockRejectedValue(error);
  let caught; try { await agent.run('Action'); } catch (e) { caught = e; }
  expect(caught).toBeDefined(); expect(caught).not.toBe(error);
  expect(caught.message).not.toMatch(/raw-private-error|private-body/);
  expect(JSON.stringify(caught)).not.toMatch(/raw-private-error|private-body/);
});

test.each([197, 253])('%i targets share descriptors once and preserve exact local fallback validation', async count => {
  const { agent, bridge, llm, executor } = setup();
  const elements = Array.from({ length: count }, (_, index) => ({ ...element, index, text: `unique-descriptor-${index}` }));
  bridge.getPageState.mockResolvedValue({ ...page, elements });
  llm.complete.mockResolvedValueOnce('{"action":"CLICK","target_CLICK":"E_999999"}').mockResolvedValueOnce(`{"action":"CLICK","target_CLICK":"E_${count - 1}"}`);
  // Large contexts are deliberately routed to fallback without truncating data.
  await agent.run('Find the last listed custom element');
  expect(llm.complete).toHaveBeenCalledTimes(2);
  const prompt = JSON.parse(llm.complete.mock.calls[0][0].messages[0].content);
  const shared = JSON.parse(prompt.state);
  expect(shared.currentTargets).toHaveLength(count);
  expect(shared.targetCoverage).toEqual({ listedCount: count, totalCount: count, omittedCount: 0 });
  expect(prompt.state.match(new RegExp(`unique-descriptor-${count - 1}`, 'g'))).toHaveLength(1);
  for (const [id, question] of Object.entries(prompt.questions)) {
    if (id === 'action') continue;
    expect(question.criteria[`E_${count - 1}`]).toBe(`[${count - 1}]`);
    expect(JSON.stringify(question)).not.toContain('unique-descriptor');
  }
  expect(executor.execute.mock.calls[0][0]).toEqual({ click: { index: count - 1 } });
});

test('oversized current DOM is not silently truncated before fallback', async () => {
  const { agent, bridge, llm, executor } = setup();
  const domText = 'x'.repeat(30000) + 'IMPORTANT_END_NODE';
  bridge.getPageState.mockResolvedValue({ ...page, domText });
  llm.complete.mockResolvedValue('{"action":"CLICK","target_CLICK":"E_0"}');
  await agent.run('Click the observed element');
  expect(global.fetch).not.toHaveBeenCalled();
  const state = JSON.parse(JSON.parse(llm.complete.mock.calls[0][0].messages[0].content).state);
  expect(state.dom).toBe(domText);
  expect(state.dom).toContain('IMPORTANT_END_NODE');
  expect(agent._stagedDecision.observations[0].truncated).toBe(true);
  expect(executor.execute).toHaveBeenCalledTimes(1);
});

test('unoffered indices remain invalid and coverage explicitly reports omitted targets', async () => {
  const { agent, bridge, llm, executor } = setup();
  bridge.getPageState.mockResolvedValue({ ...page, elements: Array.from({ length: 400 }, (_, index) => ({ ...element, index })) });
  llm.complete.mockResolvedValue('{"action":"CLICK","target_CLICK":"E_399"}');
  await expect(agent.run('Click missing target')).rejects.toThrow('Normal LLM fallback returned invalid choices');
  const prompt = JSON.parse(llm.complete.mock.calls[0][0].messages[0].content);
  expect(JSON.parse(prompt.state).targetCoverage).toEqual({ listedCount: 253, totalCount: 400, omittedCount: 147 });
  expect(prompt.questions.target_CLICK.criteria.E_399).toBeUndefined();
  expect(executor.execute).not.toHaveBeenCalled();
});

test('oversized context with fallback disabled fails closed and never queries Jev', async () => {
  const { agent, bridge, llm } = setup({ decisionConfig: { fallbackEnabled: false } });
  bridge.getPageState.mockResolvedValue({ ...page, domText: 'sensitive-value'.repeat(3000) });
  await expect(agent.run('do task')).rejects.toThrow('Jev context exceeds conservative local budget');
  expect(global.fetch).not.toHaveBeenCalled(); expect(llm.complete).not.toHaveBeenCalled();
});

test('classification telemetry survives _status without secrets across both stages and fallback', async () => {
  choices(['SCREENSHOT_NEEDED'], ['UNLISTED']);
  const onStatus = jest.fn();
  const { agent, bridge, llm } = setup({ onStatus, decisionConfig: { apiKey: 'private-key' } });
  llm.complete.mockResolvedValue('{"action":"CLICK","target_CLICK":"E_0"}');
  await agent.run('Click private-user-text');
  const decisions = bridge.sendStatus.mock.calls.map(([status]) => status.decision).filter(Boolean);
  expect(decisions).toEqual([
    { stage: 'text', provider: 'jev', action: 'SCREENSHOT_NEEDED', target: 'NONE', durationMs: expect.any(Number) },
    { stage: 'screenshot', provider: 'jev', action: null, target: null, durationMs: expect.any(Number) },
    { stage: 'screenshot', provider: 'llm-fallback', action: 'CLICK', target: 'E_0', durationMs: expect.any(Number) },
  ]);
  expect(onStatus.mock.calls.map(([status]) => status.decision).filter(Boolean)).toEqual(decisions);
  expect(JSON.stringify(decisions)).not.toMatch(/private-key|private-user-text|UNLISTED|https|data:image/);
  expect(decisions.every(decision => decision.durationMs >= 0)).toBe(true);
});

test.each(['BLOCKED', 'DONE'])('staged %s success false carries blocked terminal outcome, never success', async action => {
  choices([action]);
  const { agent, helperLlm, bridge } = setup();
  helperLlm.complete.mockResolvedValue('{"success":false,"message":"Cannot complete this request"}');
  await agent.run('Complete request');
  expect(bridge.sendStatus.mock.calls.at(-1)[0]).toMatchObject({ state: 'done', success: false, blocked: true });
  expect(bridge.sendStatus.mock.calls.some(([status]) => status.state === 'done' && status.success === true)).toBe(false);
});

test('missing input value is a blocked terminal outcome', async () => {
  choices(['TYPE', 'E_0']);
  const { agent, helperLlm, bridge } = setup(); helperLlm.complete.mockResolvedValue('{"text":null}');
  await agent.run('Fill required value');
  expect(bridge.sendStatus.mock.calls.at(-1)[0]).toMatchObject({ state: 'done', success: false, blocked: true });
});

test('successful staged completion explicitly carries success true and blocked false', async () => {
  choices(['DONE']);
  const { agent, helperLlm, bridge } = setup(); helperLlm.complete.mockResolvedValue('{"success":true,"message":"Observed completion"}');
  await agent.run('Complete request');
  expect(bridge.sendStatus.mock.calls.at(-1)[0]).toMatchObject({ state: 'done', success: true, blocked: false });
});

test('Jev explicitly escalates even when normal-mode useVision is disabled', async () => {
  choices(['SCREENSHOT_NEEDED'], ['CLICK', 'E_0']);
  const { agent, bridge } = setup({ useVision: false });
  await agent.run('Visual task');
  expect(bridge.takeScreenshot).toHaveBeenCalledTimes(1);
});

test('normal mode remains independent of unused invalid Jev config', async () => {
  const { agent, llm, bridge } = setup({ decisionMode: 'llm', decisionConfig: { baseUrl: 'bad' } });
  llm.complete.mockResolvedValue('{"action":{"done":{"success":true,"message":"normal"}}}');
  expect(await agent.run('read')).toBe('normal');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(bridge.takeScreenshot).not.toHaveBeenCalled();
});
