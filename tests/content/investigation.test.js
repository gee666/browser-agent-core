import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { ActionExecutor } from '../../background/executor.js';

let handler;
const rect = { left: 50, top: 50, right: 150, bottom: 90, width: 100, height: 40 };
function message(type, params = {}) {
  let response;
  handler({ type, ...params }, {}, value => { response = value; });
  return response;
}
beforeEach(() => {
  document.body.innerHTML = '';
  chrome.runtime.onMessage.addListener.mockClear();
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  // Each extractor has its own bounded target registry.
  eval(readFileSync(new URL('../../content/extractor.js', import.meta.url), 'utf8'));
  handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
});
afterEach(() => jest.restoreAllMocks());

test('inspection is read-only, bounded, and contains structural locators but no field values/handlers', () => {
  document.body.innerHTML = '<input value="private-secret"><button onclick="bad()">Go</button><div>Missed widget</div>';
  document.querySelector('input').value = 'private-secret';
  const focus = jest.spyOn(HTMLElement.prototype, 'focus');
  const click = jest.spyOn(HTMLElement.prototype, 'click');
  const inspect = message('inspect_dom', { selector: 'body', limit: 2 });
  expect(inspect.ok).toBe(true);
  expect(inspect.elements).toHaveLength(2);
  expect(inspect.truncated).toBe(true);
  expect(inspect.elements[0].locator).toContain(':nth-child(');
  expect(JSON.stringify(inspect)).not.toMatch(/private-secret|onclick|bad\(\)/);
  expect(focus).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
});

test('invalid selectors and unmatched selectors return bounded structured responses', () => {
  expect(message('inspect_dom', { selector: '[' })).toEqual({ ok: false, reason: 'invalid selector' });
  expect(message('inspect_dom', { selector: '#missing' })).toMatchObject({ ok: true, elements: [], truncated: false });
});

test('resolve registers a missed ordinary element using the existing coordinate shape', () => {
  document.body.innerHTML = '<button>Listed</button><div id="missed">Custom widget</div>';
  const initial = message('get_page_state');
  expect(initial.elements.some(e => e.attrs.id === 'missed')).toBe(false);
  const resolved = message('resolve_dom_target', { selector: '#missed', expectedUrl: location.href });
  expect(resolved.ok).toBe(true);
  const found = resolved.pageState.elements.find(e => e.index === resolved.index);
  expect(found).toMatchObject({ tag: 'div', attrs: { id: 'missed' }, rect: { x: 50, y: 50, w: 100, h: 40 }, inViewport: true });
  expect(resolved.pageState.domText).toContain(`[${resolved.index}]<div`);
  const refreshed = message('get_page_state');
  expect(refreshed.elements.find(e => e.index === resolved.index)?.attrs.id).toBe('missed');
  expect(document.querySelector(resolved.locator)).toBe(document.getElementById('missed'));
});

test('registered target executes via native input executor without changing its timing or coordinates', async () => {
  document.body.innerHTML = '<div id="missed">Custom widget</div>';
  const resolved = message('resolve_dom_target', { selector: '#missed', expectedUrl: location.href });
  const inputControl = { execute: jest.fn().mockResolvedValue() };
  const bridge = { getActiveTabId: jest.fn().mockResolvedValue(1), getPageState: jest.fn().mockImplementation(async () => message('get_page_state')) };
  const executor = new ActionExecutor({ inputControl, bridge });
  executor._sleep = jest.fn().mockResolvedValue();
  executor._rand = () => 0;
  executor._jitterCoords = (r, x, y) => ({ x, y });
  await executor.execute({ click: { index: resolved.index } }, resolved.pageState);
  expect(inputControl.execute.mock.calls.map(([cmd]) => cmd)).toEqual(['mouse_move', 'mouse_click']);
  expect(inputControl.execute.mock.calls[0][1]).toEqual({ x: 100, y: 70, duration_ms: 350 });
  expect(inputControl.execute.mock.calls[1][1]).toMatchObject({ x: 100, y: 70, hold_ms: 40 });
});

test('normal extraction remains unchanged before registration and disconnected registrations are pruned', () => {
  document.body.innerHTML = '<div id="missed">Custom widget</div>';
  expect(message('get_page_state').elements).toHaveLength(0);
  message('resolve_dom_target', { selector: '#missed', expectedUrl: location.href });
  document.getElementById('missed').remove();
  expect(message('get_page_state').elements).toHaveLength(0);
});

test.each([
  ['<div class="target"></div><div class="target"></div>', '.target'],
  ['<button id="target" disabled>Disabled</button>', '#target'],
  ['<div id="target" style="display:none">Hidden</div>', '#target'],
  ['<div id="target" aria-disabled="true">Disabled</div>', '#target'],
])('resolve rejects ambiguous, hidden and disabled targets %#', (html, selector) => {
  document.body.innerHTML = html;
  expect(message('resolve_dom_target', { selector, expectedUrl: location.href }).ok).toBe(false);
});

test('resolve rejects stale URLs, invalid CSS and off-screen targets', () => {
  document.body.innerHTML = '<div id="target">Widget</div>';
  expect(message('resolve_dom_target', { selector: '#target', expectedUrl: 'https://other.test/' }).ok).toBe(false);
  expect(message('resolve_dom_target', { selector: '[', expectedUrl: location.href }).ok).toBe(false);
  document.getElementById('target').getBoundingClientRect = () => ({ ...rect, top: -100, bottom: -60 });
  expect(message('resolve_dom_target', { selector: '#target', expectedUrl: location.href })).toMatchObject({ ok: false, reason: 'target is off screen' });
});

test.each(['data-page-agent-ignore', 'aria-hidden', 'aria-disabled'])('excluded ancestor %s prevents inspection and registration', attribute => {
  document.body.innerHTML = `<section ${attribute}="true"><div id="target">Widget</div></section>`;
  expect(message('inspect_dom', { selector: '#target' }).elements).toHaveLength(0);
  expect(message('resolve_dom_target', { selector: '#target', expectedUrl: location.href }).ok).toBe(false);
});

test.each(['data-page-agent-ignore', 'aria-hidden', 'aria-disabled'])('registered targets are pruned when %s is set', attribute => {
  document.body.innerHTML = '<section><div id="target">Widget</div></section>';
  const resolved = message('resolve_dom_target', { selector: '#target', expectedUrl: location.href });
  expect(resolved.ok).toBe(true);
  document.querySelector('section').setAttribute(attribute, 'true');
  expect(message('get_page_state').elements.some(e => e.attrs.id === 'target')).toBe(false);
});

test('resolution returns structural DOM ancestry and children without copied HTML or raw field values', () => {
  document.body.innerHTML = '<section role="region" id="private-id"><div id="target" role="button" aria-label="private-label"><input type="password" value="private-password"><span>private-text</span></div></section>';
  const result = message('resolve_dom_target', { selector: '#target', expectedUrl: location.href });
  expect(result.ok).toBe(true);
  expect(result.domContext.target.tag).toBe('div');
  expect(result.domContext.target.attributeNames).toEqual(expect.arrayContaining(['id', 'role', 'aria-label']));
  expect(result.domContext.ancestors[0]).toMatchObject({ tag: 'section', attrs: { role: 'region' }, childElementCount: 1 });
  expect(result.domContext.children[0]).toMatchObject({ tag: 'input', attrs: { type: 'password' } });
  expect(JSON.stringify(result.domContext)).not.toMatch(/private-id|private-label|private-password|private-text/);
  expect(document.querySelector(result.domContext.target.locator)).toBe(document.getElementById('target'));
});

test('registration cap prevents unlimited forced elements', () => {
  document.body.innerHTML = Array.from({ length: 21 }, (_, i) => `<div id="target${i}">Widget</div>`).join('');
  for (let i = 0; i < 20; i++) expect(message('resolve_dom_target', { selector: `#target${i}`, expectedUrl: location.href }).ok).toBe(true);
  expect(message('resolve_dom_target', { selector: '#target20', expectedUrl: location.href })).toMatchObject({ ok: false, reason: 'discovery limit reached' });
});
