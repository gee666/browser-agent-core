import { jest } from '@jest/globals';
import { inspectScriptPage, NativeScriptPageBridge } from '../../background/native-script-page.js';

const box = (x, y, width, height) => ({ x, y, width, height });
function element(selector, bounds) {
  const el = document.querySelector(selector);
  el.getBoundingClientRect = jest.fn().mockReturnValue(bounds);
  return el;
}
function metric(el, key, value) { Object.defineProperty(el, key, { value, configurable: true }); }
beforeEach(() => {
  chrome.windows = { get: jest.fn().mockResolvedValue({ focused: true }) };
  document.body.innerHTML = '<div id="container"><input id="input" value="test"><button id="button">Hello</button></div>';
  document.elementFromPoint = jest.fn().mockReturnValue(document.querySelector('#button'));
  metric(window, 'innerWidth', 1000); metric(window, 'innerHeight', 800);
  metric(document.documentElement, 'scrollWidth', 1000); metric(document.documentElement, 'scrollHeight', 4000);
  metric(document.body, 'scrollWidth', 1000); metric(document.body, 'scrollHeight', 4000);
  element('#container', box(0, 0, 900, 700));
});

it.each([
  [{ op: 'read', property: 'title' }, () => document.title],
  [{ op: 'read', property: 'url' }, () => location.href],
  [{ op: 'read', property: 'pageHeight' }, () => 4000],
  [{ op: 'read', selector: '#button', property: 'textContent' }, () => 'Hello'],
  [{ op: 'read', selector: '#input', property: 'value' }, () => 'test'],
  [{ op: 'read', selector: 'button', property: 'textContent', all: true }, () => ['Hello']],
  [{ op: 'read', selector: '.missing', property: 'exists' }, () => false],
  [{ op: 'read', selector: '.missing', property: 'count' }, () => 0],
])('reads allowed properties without source execution: %j', (request, expected) => {
  expect(inspectScriptPage(request)).toEqual(expected());
});

it('returns explicit rectangle data and native context', () => {
  element('#button', box(20, 30, 100, 50));
  expect(inspectScriptPage({ op: 'read', selector: '#button', property: 'rect' })).toEqual(box(20, 30, 100, 50));
  expect(inspectScriptPage({ op: 'target', selector: '#button' })).toMatchObject({ visible: true, x: 70, y: 55, width: 1000, height: 800, context: { innerWidth: 1000, innerHeight: 800 } });
});

it('returns a native viewport wheel instruction for an offscreen target without scrolling DOM', () => {
  const el = element('#button', box(20, 1800, 100, 50));
  el.scrollIntoView = jest.fn(); window.scrollTo = jest.fn();
  const result = inspectScriptPage({ op: 'target', selector: '#button' });
  expect(result).toMatchObject({ visible: false, scroll: { x: 500, y: 400, deltaY: 1425 } });
  expect(el.scrollIntoView).not.toHaveBeenCalled();
  expect(window.scrollTo).not.toHaveBeenCalled();
});

it('calculates wheel coordinates inside a clipped nested scroll container', () => {
  const container = document.querySelector('#container');
  container.style.overflowY = 'auto';
  element('#container', box(100, 100, 300, 200));
  metric(container, 'clientWidth', 300); metric(container, 'clientHeight', 200);
  metric(container, 'scrollHeight', 1200); metric(container, 'scrollTop', 0);
  element('#button', box(150, 600, 100, 50));
  document.elementFromPoint.mockReturnValue(container);
  expect(inspectScriptPage({ op: 'target', selector: '#button' })).toMatchObject({ visible: false, scroll: { x: 250, y: 200, deltaY: 425 } });
});

it('rejects an obscured scroll container', () => {
  const container = document.querySelector('#container');
  container.style.overflowY = 'auto';
  element('#container', box(100, 100, 300, 200));
  metric(container, 'clientWidth', 300); metric(container, 'clientHeight', 200);
  metric(container, 'scrollHeight', 1200);
  element('#button', box(150, 600, 100, 50));
  document.elementFromPoint.mockReturnValue(document.body);
  expect(() => inspectScriptPage({ op: 'target', selector: '#button' })).toThrow(/obscured/);
});

it.each(['display:none', 'visibility:hidden', 'opacity:0'])('rejects hidden ancestors: %s', style => {
  document.querySelector('#container').style.cssText = style;
  element('#button', box(20, 30, 100, 50));
  expect(() => inspectScriptPage({ op: 'target', selector: '#button' })).toThrow(/hidden/);
});

it('rejects hidden clipping with no native path instead of DOM scrolling', () => {
  const container = document.querySelector('#container');
  container.style.overflowY = 'hidden';
  metric(container, 'clientHeight', 100); metric(container, 'clientWidth', 300);
  element('#container', box(100, 100, 300, 100));
  element('#button', box(150, 500, 100, 50));
  const result = inspectScriptPage({ op: 'target', selector: '#button' });
  expect(result.visible).toBe(false);
  expect(result.scroll.deltaY).toBe(0);
});

it('rejects ambiguous, missing, disabled and covered targets', () => {
  element('#button', box(20, 30, 100, 50));
  expect(() => inspectScriptPage({ op: 'target', selector: 'button,input' })).toThrow(/exactly one/);
  expect(() => inspectScriptPage({ op: 'target', selector: '.missing' })).toThrow(/exactly one/);
  document.querySelector('#button').disabled = true;
  expect(() => inspectScriptPage({ op: 'target', selector: '#button' })).toThrow(/disabled/);
  document.querySelector('#button').disabled = false;
  document.elementFromPoint.mockReturnValue(document.body);
  expect(() => inspectScriptPage({ op: 'target', selector: '#button' })).toThrow(/obscured/);
});

it('hard-codes the read allowlist even if called without plan validation', () => {
  expect(() => inspectScriptPage({ op: 'read', selector: '#input', property: 'focus' })).toThrow(/Unsupported/);
  expect(() => inspectScriptPage({ op: 'eval', selector: '#input' })).toThrow();
  expect(() => inspectScriptPage({ op: 'read', selector: 'input,button', property: 'value' })).toThrow(/exactly one/);
});

it('injects only the fixed read function in ISOLATED world, never source', async () => {
  chrome.scripting.executeScript.mockResolvedValue([{ result: 'Page title' }]);
  const bridge = new NativeScriptPageBridge();
  const read = { op: 'read', property: 'title' };
  await expect(bridge.read(7, read)).resolves.toBe('Page title');
  expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith({ target: { tabId: 7 }, world: 'ISOLATED', func: inspectScriptPage, args: [read] });
});

it('rejects failed inspection and inactive target tabs', async () => {
  const bridge = new NativeScriptPageBridge();
  chrome.scripting.executeScript.mockResolvedValue([{ error: 'unavailable' }]);
  await expect(bridge.snapshot(7)).rejects.toMatchObject({ code: 'E_SCRIPT_PAGE' });
  chrome.tabs.query.mockResolvedValue([{ id: 8 }]);
  await expect(bridge.assertActive(7)).rejects.toMatchObject({ code: 'E_SCRIPT_TAB' });
  chrome.tabs.query.mockResolvedValue([{ id: 7 }]);
  await expect(bridge.assertActive(7)).resolves.toBeUndefined();
  chrome.windows.get.mockResolvedValue({ focused: false });
  await expect(bridge.assertActive(7)).rejects.toMatchObject({ code: 'E_SCRIPT_TAB' });
});
