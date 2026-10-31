import { fail, SCRIPT_LIMITS, checkJSON } from './native-script-plan.js';

/**
 * Chrome serializes this fixed function into the isolated world. request contains
 * data only. Never add source/code/function fields or a general property lookup.
 */
export function inspectScriptPage(request) {
  const context = {
    screenX: window.screenX, screenY: window.screenY,
    outerHeight: window.outerHeight, innerHeight: window.innerHeight,
    outerWidth: window.outerWidth, innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY,
  };
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
  };
  const viewport = { x: 1, y: 1, width: width - 2, height: height - 2 };
  if (request.op === 'snapshot') return { context, width, height, url: location.href,
    scrollX: window.scrollX, scrollY: window.scrollY,
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) };
  if (request.op === 'read' && request.selector === undefined) {
    switch (request.property) {
      case 'title': return document.title;
      case 'url': return location.href;
      case 'scrollX': return window.scrollX;
      case 'scrollY': return window.scrollY;
      case 'viewportWidth': return width;
      case 'viewportHeight': return height;
      case 'pageWidth': return Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
      case 'pageHeight': return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      default: throw new Error('Unsupported page read');
    }
  }
  if (typeof request.selector !== 'string' || !request.selector.length || request.selector.length > 4096) throw new Error('Invalid selector');
  const elements = document.querySelectorAll(request.selector);
  if (request.op === 'read') {
    if (request.property === 'count') return elements.length;
    if (request.property === 'exists') return elements.length > 0;
    if (elements.length > 1000) throw new Error('Too many read matches');
    if (!request.all && elements.length !== 1) throw new Error('Read requires exactly one match');
    const read = el => {
      switch (request.property) {
        case 'textContent': return el.textContent;
        case 'innerText': return el.innerText;
        case 'innerHTML': return el.innerHTML;
        case 'outerHTML': return el.outerHTML;
        case 'value':
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) throw new Error('Value read requires a form control');
          return el.value;
        case 'checked':
          if (!(el instanceof HTMLInputElement)) throw new Error('Checked read requires an input');
          return el.checked;
        case 'disabled':
          if (!('disabled' in el)) throw new Error('Element does not support disabled');
          return el.disabled;
        case 'tagName': return el.tagName;
        case 'attribute': return el.getAttribute(request.attribute);
        case 'rect': return rect(el.getBoundingClientRect());
        default: throw new Error('Unsupported element read');
      }
    };
    return request.all ? Array.from(elements, read) : read(elements[0]);
  }
  if (request.op !== 'target' || elements.length !== 1) throw new Error('Target requires exactly one match');
  const el = elements[0];
  if (!el.isConnected || el.matches(':disabled') || el.closest('[inert]')) throw new Error('Target is disabled or detached');
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity !== '' && Number(style.opacity) === 0) throw new Error('Target is hidden');
  }
  const target = rect(el.getBoundingClientRect());
  if (target.width <= 0 || target.height <= 0) throw new Error('Target has no layout box');
  let visible = intersect(target, viewport);
  const ancestors = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const box = rect(node.getBoundingClientRect());
    const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
    const clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
    if (clipX || clipY) {
      // Clip only the affected axis. Borders are excluded from the client box.
      const clip = { x: clipX ? box.x + node.clientLeft : -1e9, y: clipY ? box.y + node.clientTop : -1e9,
        width: clipX ? node.clientWidth : 2e9, height: clipY ? node.clientHeight : 2e9 };
      visible = intersect(visible, clip);
      ancestors.push({ node, box, clip, style });
    }
  }
  if (visible.width >= 2 && visible.height >= 2) {
    const x = Math.round(visible.x + visible.width / 2);
    const y = Math.round(visible.y + visible.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) throw new Error('Target is obscured');
    return { context, width, height, url: location.href, x, y, visible: true,
      multiline: el instanceof HTMLTextAreaElement || el.isContentEditable === true,
      primaryModifier: /Mac/.test(navigator.platform) ? 'command' : 'control',
      editable: el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(el.type) && !el.readOnly
        || el instanceof HTMLTextAreaElement && !el.readOnly || el.isContentEditable === true };
  }
  // Find a visible native wheel recipient. Do not use scrollIntoView/scrollTo.
  for (let i = 0; i < ancestors.length; i++) {
    const { node, box, style } = ancestors[i];
    const dx = target.x + target.width / 2 - (box.x + box.width / 2);
    const dy = target.y + target.height / 2 - (box.y + box.height / 2);
    const canX = /(auto|scroll)/.test(style.overflowX) && (dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth : node.scrollLeft > 0);
    const canY = /(auto|scroll)/.test(style.overflowY) && (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight : node.scrollTop > 0);
    if (!canX && !canY) continue;
    let recipient = intersect(box, viewport);
    for (let j = i + 1; j < ancestors.length; j++) recipient = intersect(recipient, ancestors[j].clip);
    if (recipient.width < 2 || recipient.height < 2) continue;
    const x = Math.round(recipient.x + recipient.width / 2), y = Math.round(recipient.y + recipient.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit))) throw new Error('Scroll container is obscured');
    return { context, width, height, url: location.href, visible: false, scroll: { x, y, deltaX: canX ? dx : 0, deltaY: canY ? dy : 0 } };
  }
  return { context, width, height, url: location.href, visible: false,
    scroll: { x: Math.round(width / 2), y: Math.round(height / 2),
      deltaX: target.x + target.width <= 0 || target.x >= width ? target.x + target.width / 2 - width / 2 : 0,
      deltaY: target.y + target.height <= 0 || target.y >= height ? target.y + target.height / 2 - height / 2 : 0 } };
}

/** Trusted read-only adapter. It never receives external source or generated code. */
export class NativeScriptPageBridge {
  async _call(tabId, request) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: inspectScriptPage, args: [request] });
    if (!Array.isArray(results) || results.length !== 1 || results[0].error) fail('E_SCRIPT_PAGE', 'Read-only page inspection failed');
    const value = results[0].result;
    if (value !== undefined) checkJSON(value, SCRIPT_LIMITS.result);
    return value;
  }
  snapshot(tabId) { return this._call(tabId, { op: 'snapshot' }); }
  target(tabId, selector) { return this._call(tabId, { op: 'target', selector }); }
  read(tabId, step) { return this._call(tabId, step); }
  async assertActive(tabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs?.length !== 1 || tabs[0].id !== tabId) fail('E_SCRIPT_TAB', 'Native input requires the target tab to be active');
    const window = await chrome.windows.get(tabs[0].windowId);
    if (!window?.focused) fail('E_SCRIPT_TAB', 'Native input requires the target Chrome window to be focused');
  }
}
