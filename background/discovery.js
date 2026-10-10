// Persistence-safe miss diagnostics. Never copy free text, labels, identifiers,
// input values, model explanations, arbitrary HTML or screenshot pixels.
const TAG = /^[a-z][a-z0-9-]{0,63}$/;
const LOCATOR = /^(?:[a-z][a-z0-9-]{0,63}:nth-child\([1-9]\d{0,6}\))(?:\s*>\s*[a-z][a-z0-9-]{0,63}:nth-child\([1-9]\d{0,6}\))*$/;
const ROLES = new Set('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(' '));
const TYPES = new Set('button checkbox color date datetime-local email file hidden image month number password radio range reset search submit tel text time url week'.split(' '));
const BOOL = new Set(['true', 'false']);
const ATTRIBUTE_NAMES = new Set('id class role type tabindex contenteditable aria-label aria-labelledby placeholder title data-testid data-test-id data-cy onclick'.split(' '));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const safeInteger = n => Number.isInteger(n) && n >= 0;

const containsSecret = (value, secrets) => secrets.some(secret => value === secret || secret.length >= 4 && value.includes(secret));

export function safeLocator(value, secrets = []) {
  return typeof value === 'string' && value.length <= 4000 && LOCATOR.test(value) && !containsSecret(value, secrets) ? value : null;
}

export function sensitiveValues(page, config) {
  return [config.apiKey, ...Object.values(config.headers || {}), ...(page.elements || []).flatMap(e => [e.currentValue, e.attrs?.value])]
    .filter(value => typeof value === 'string' && value.length > 0);
}

export function sanitizedPageURL(value, secrets = []) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const known = [...secrets, ...url.searchParams.values()].filter(s => typeof s === 'string' && s.length > 0);
    let sensitiveRoute = false;
    const path = url.pathname.split('/').map(segment => {
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch { return '[redacted]'; }
      if (!decoded) return segment;
      const redact = sensitiveRoute || containsSecret(decoded, known) ||
        /[\u0000-\u001f\u007f@<>"'`\\]/.test(decoded) || /(?:bearer|password|secret|api[-_]?key|token)[=:_-]/i.test(decoded) ||
        /^[A-Za-z0-9_-]{24,}$/.test(decoded) && (/[0-9]/.test(decoded) || /[a-z]/.test(decoded) && /[A-Z]/.test(decoded)) ||
        /^[a-z]{32,}$/i.test(decoded) || /\beyJ[A-Za-z0-9_-]+\./.test(decoded);
      if (/^(?:reset|reset-password|password-reset|invite|invitation|token|tokens|credentials|api-keys)$/i.test(decoded)) sensitiveRoute = true;
      return redact ? '[redacted]' : segment;
    }).join('/');
    return url.origin + path;
  } catch { return ''; }
}

function structuralNode(node, secrets) {
  if (!node || typeof node !== 'object') return null;
  const tag = typeof node.tag === 'string' && TAG.test(node.tag) && !containsSecret(node.tag, secrets) ? node.tag : 'element';
  const attrs = {};
  const input = node.attrs || {};
  if (ROLES.has(input.role)) attrs.role = input.role;
  if (TYPES.has(input.type)) attrs.type = input.type;
  for (const key of ['aria-expanded', 'aria-disabled', 'aria-hidden', 'aria-selected', 'aria-checked', 'aria-readonly']) {
    if (BOOL.has(input[key]) || key === 'aria-checked' && input[key] === 'mixed') attrs[key] = input[key];
  }
  if (['true', 'false', 'plaintext-only'].includes(input.contenteditable)) attrs.contenteditable = input.contenteditable;
  if (typeof input.tabindex === 'string' && /^-?\d{1,5}$/.test(input.tabindex)) attrs.tabindex = input.tabindex;
  const result = { tag, attrs, attributeNames: (Array.isArray(node.attributeNames) ? node.attributeNames : []).filter(name => ATTRIBUTE_NAMES.has(name)).slice(0, 14) };
  if (safeInteger(node.childElementCount)) result.childElementCount = Math.min(node.childElementCount, 1000000);
  if (safeInteger(node.index)) result.index = node.index;
  const locator = safeLocator(node.locator, secrets);
  if (locator) result.locator = locator;
  return result;
}

export function sanitizedDOMContext(context, element, secrets = []) {
  const target = structuralNode(context?.target || element, secrets);
  if (!target) return null;
  const ancestors = (Array.isArray(context?.ancestors) ? context.ancestors : []).slice(0, 6).map(node => structuralNode(node, secrets)).filter(Boolean);
  const children = (Array.isArray(context?.children) ? context.children : []).slice(0, 8).map(node => structuralNode(node, secrets)).filter(Boolean);
  const markup = node => `<${node.tag}${Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>`;
  // This is generated structural markup, not copied outerHTML.
  const excerpt = [...ancestors.slice().reverse().map(markup), markup(target), ...children.map(markup)].join('\n').slice(0, 4000);
  return { target, ancestors, children, excerpt };
}

export function safeRect(rect) {
  return rect && ['x', 'y', 'w', 'h'].every(key => finite(rect[key]))
    ? Object.fromEntries(['x', 'y', 'w', 'h'].map(key => [key, rect[key]])) : null;
}
