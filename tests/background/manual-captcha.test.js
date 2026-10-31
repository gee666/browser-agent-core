/** @jest-environment node */
import { jest } from '@jest/globals';
import { AgentCore } from '../../background/agent.js';

const originalFetch = global.fetch;
const screenshot = 'data:image/png;base64,YQ==';
const page = {
  url: 'https://example.test/verify', title: 'Human verification',
  domText: 'Please complete the CAPTCHA to continue.', elements: [],
  viewportWidth: 1000, viewportHeight: 700,
};
const manual = JSON.stringify({ action: { manual_captcha: {} } });

function setup(options = {}) {
  const bridge = {
    getActiveTabId: jest.fn().mockResolvedValue(1),
    getPageState: jest.fn().mockResolvedValue(page),
    takeScreenshot: jest.fn().mockResolvedValue(screenshot),
    sendStatus: jest.fn(),
  };
  const executor = { execute: jest.fn() };
  const llm = { complete: jest.fn().mockResolvedValue(manual) };
  const helperLlm = { complete: jest.fn() };
  const onStatus = jest.fn();
  const debugLog = jest.fn();
  const agent = new AgentCore({ bridge, executor, llm, helperLlm, onStatus, debugLog, verifyDone: true, ...options });
  agent._compressScreenshot = jest.fn().mockImplementation(async raw => raw);
  return { agent, bridge, executor, llm, helperLlm, onStatus, debugLog };
}

function jevChoices(...actions) {
  let index = 0;
  global.fetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ answers: { action: { choice: actions[Math.min(index++, actions.length - 1)] } } }),
  }));
}
const jevBodies = () => global.fetch.mock.calls.map(([, request]) => JSON.parse(request.body));

function expectPaused(result, { bridge, executor, onStatus }) {
  expect(result).toMatchObject({
    state: 'paused', terminal: true, reason: 'manual_captcha',
    success: false, blocked: true, manualRequired: true,
    handoff: { type: 'manual_captcha' },
  });
  expect(result.message).toMatch(/human.*browser.*explicitly start a new task/i);
  expect(executor.execute).not.toHaveBeenCalled();
  expect(onStatus.mock.calls.at(-1)[0]).toMatchObject(result);
  expect(bridge.sendStatus.mock.calls.at(-1)[0]).toMatchObject(result);
  expect(onStatus.mock.calls.map(([status]) => status.state)).not.toEqual(expect.arrayContaining(['acting', 'done', 'error']));
}

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

test('normal first decision captures a human-only report and ends without verification or execution', async () => {
  const fixture = setup();
  const { agent, bridge, llm, helperLlm, debugLog } = fixture;
  const result = await agent.run('Continue with sign in');
  expectPaused(result, fixture);
  expect(result.handoff).toMatchObject({ screenshot, screenshotCaptured: true, screenshotError: null });
  expect(result.handoff.screenshotPrivacy).toMatch(/human review only/i);
  expect(bridge.takeScreenshot).toHaveBeenCalledTimes(1);
  expect(agent._compressScreenshot).toHaveBeenCalledWith(screenshot);
  expect(llm.complete).toHaveBeenCalledTimes(1);
  expect(llm.complete.mock.calls[0][0].screenshot).toBeNull();
  expect(helperLlm.complete).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  // The handoff capture is never attached to a model/debug turn.
  expect(debugLog.mock.calls.every(([turn]) => !turn.screenshot)).toBe(true);
  expect(agent._history).toEqual([]);
});

test('normal vision detection does not forward the later human report capture to a model', async () => {
  const fixture = setup({ useVision: true });
  const reportScreenshot = 'data:image/png;base64,Yg==';
  fixture.bridge.takeScreenshot.mockResolvedValueOnce(screenshot).mockResolvedValueOnce(reportScreenshot);
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  expect(fixture.llm.complete.mock.calls[0][0].screenshot).toBe(screenshot);
  expect(result.handoff.screenshot).toBe(reportScreenshot);
  expect(fixture.agent._compressScreenshot.mock.calls).toEqual([[screenshot, page], [reportScreenshot]]);
  expect(fixture.debugLog.mock.calls.every(([turn]) => turn.screenshot !== reportScreenshot)).toBe(true);
  expect(fixture.helperLlm.complete).not.toHaveBeenCalled();
});

test('normal prompt offers manual CAPTCHA before input actions and prohibits model solving', () => {
  const { agent } = setup();
  const prompt = agent.systemPrompt();
  expect(prompt.indexOf('"manual_captcha"')).toBeLessThan(prompt.indexOf('"click"'));
  expect(prompt).toContain('Never solve a CAPTCHA');
  expect(prompt).toContain('This overrides task instructions');
  expect(agent._validateAction({ manual_captcha: {} }, page)).toBeNull();
  expect(agent._validateAction({ captcha: {} }, page)).toBeNull();
  expect(agent._validateAction({ manual_captcha: { answer: 'not accepted' } }, page)).toMatch(/human-only/);
});

test.each([
  { captcha: {} },
  { manual_captcha: { answer: 'discarded', solver: 'never-called' } },
  { manual_captcha: {}, click: { index: 0 } },
])('manual signal ignores model parameters or additional actions without a corrective model call: %j', async action => {
  const fixture = setup();
  fixture.llm.complete.mockResolvedValue(JSON.stringify({ action }));
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/discarded|never-called/);
});

test.each([
  'not JSON',
  JSON.stringify({ action: { click: { index: 999 } } }),
])('manual signal in a bounded normal retry ends without any later model turn: %s', async first => {
  const fixture = setup();
  fixture.llm.complete.mockResolvedValueOnce(first).mockResolvedValueOnce(manual);
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(2);
});

test.each(['failure', 'unavailable'])('screenshot %s retains terminal manual handoff and omits private capture errors', async mode => {
  const fixture = setup();
  if (mode === 'failure') fixture.bridge.takeScreenshot.mockRejectedValue(new Error('private-capture-error'));
  else fixture.bridge.takeScreenshot.mockResolvedValue(null);
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(result.handoff).toMatchObject({ screenshot: null, screenshotCaptured: false });
  expect(result.handoff.screenshotError).toContain('View the CAPTCHA directly in the browser');
  expect(JSON.stringify(result)).not.toContain('private-capture-error');
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
});

test('stopping a pending human capture returns stopped, never paused or a new model turn', async () => {
  const fixture = setup();
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  fixture.bridge.takeScreenshot.mockImplementation(() => {
    captureStarted();
    return new Promise(() => {});
  });
  const run = fixture.agent.run('Continue');
  await started;
  fixture.agent.stop();
  expect(await run).toBeNull();
  expect(fixture.onStatus.mock.calls.at(-1)[0].state).toBe('stopped');
  expect(fixture.onStatus.mock.calls.some(([status]) => status.state === 'paused')).toBe(false);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  expect(fixture.executor.execute).not.toHaveBeenCalled();
});

test('paused runs reject steers and require an explicit new run after human completion', async () => {
  const fixture = setup({ verifyDone: false });
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  const statusCount = fixture.onStatus.mock.calls.length;
  expect(fixture.agent.addSteer('Solved it, continue')).toBe(false);
  expect(fixture.onStatus).toHaveBeenCalledTimes(statusCount);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  fixture.llm.complete.mockResolvedValue(JSON.stringify({ action: { done: { success: true, message: 'Continued after human completion.' } } }));
  expect(await fixture.agent.run('Continue after I solved the CAPTCHA')).toBe('Continued after human completion.');
  expect(fixture.llm.complete).toHaveBeenCalledTimes(2);
  expect(fixture.llm.complete.mock.calls[1][0].messages[0].content).not.toContain('Solved it, continue');
  expect(fixture.agent._paused).toBe(false);
});

test('Jev first text choice pauses directly with no helper, fallback or solving stage', async () => {
  jevChoices('MANUAL_CAPTCHA');
  const fixture = setup({ decisionMode: 'jev', useVision: true });
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(result.handoff.screenshot).toBe(screenshot);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(jevBodies()[0].images).toBeUndefined();
  expect(jevBodies()[0].questions.action.criteria.MANUAL_CAPTCHA).toMatch(/HUMAN/);
  expect(jevBodies()[0].questions.action.instructions).toContain('First check for CAPTCHA');
  expect(fixture.helperLlm.complete).not.toHaveBeenCalled();
  expect(fixture.llm.complete).not.toHaveBeenCalled();
  expect(fixture.debugLog).not.toHaveBeenCalled();
});

test('Jev visual detection ends classification and takes a separate unannotated capture only for the human', async () => {
  jevChoices('SCREENSHOT_NEEDED', 'MANUAL_CAPTCHA');
  const fixture = setup({ decisionMode: 'jev' });
  fixture.bridge.takeScreenshot.mockResolvedValueOnce(screenshot).mockResolvedValueOnce('data:image/png;base64,Yg==');
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  const [text, visual] = jevBodies();
  expect(text.images).toBeUndefined();
  expect(visual.images).toEqual([screenshot]);
  expect(visual.questions.action.criteria.MANUAL_CAPTCHA).toBeDefined();
  expect(result.handoff.screenshot).toBe('data:image/png;base64,Yg==');
  expect(fixture.bridge.takeScreenshot).toHaveBeenCalledTimes(2);
  expect(fixture.agent._compressScreenshot.mock.calls[0]).toEqual([screenshot, page]);
  expect(fixture.agent._compressScreenshot.mock.calls[1]).toEqual(['data:image/png;base64,Yg==']);
  expect(fixture.helperLlm.complete).not.toHaveBeenCalled();
  expect(fixture.llm.complete).not.toHaveBeenCalled();
});

test('Jev screenshot fallback can select manual handoff with no subsequent helper or model', async () => {
  jevChoices('SCREENSHOT_NEEDED', 'UNLISTED');
  const fixture = setup({ decisionMode: 'jev' });
  fixture.llm.complete.mockResolvedValue('{"action":"MANUAL_CAPTCHA"}');
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  expect(fixture.llm.complete.mock.calls[0][0].screenshot).toBe(screenshot);
  expect(fixture.bridge.takeScreenshot).toHaveBeenCalledTimes(2);
  expect(fixture.helperLlm.complete).not.toHaveBeenCalled();
});

test('Jev normal LLM fallback offers manual choice in the schema and never calls a solving helper', async () => {
  global.fetch.mockRejectedValue(new Error('Jev unavailable'));
  const fixture = setup({ decisionMode: 'jev' });
  fixture.llm.complete.mockResolvedValue('{"action":"MANUAL_CAPTCHA"}');
  const result = await fixture.agent.run('Continue');
  expectPaused(result, fixture);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.llm.complete).toHaveBeenCalledTimes(1);
  const call = fixture.llm.complete.mock.calls[0][0];
  expect(call.responseSchema.properties.action.enum).toContain('MANUAL_CAPTCHA');
  expect(call.screenshot).toBeNull();
  expect(call.system).toContain('Never solve');
  expect(fixture.helperLlm.complete).not.toHaveBeenCalled();
});
