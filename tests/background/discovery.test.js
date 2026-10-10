/** @jest-environment node */
import { sanitizedPageURL, sanitizedDOMContext, safeLocator, safeRect } from '../../background/discovery.js';

test('retains useful path while stripping userinfo, query and hash', () => {
  expect(sanitizedPageURL('https://user:secret@example.com:8443/d/route-id/view?secret=private#fragment')).toBe('https://example.com:8443/d/route-id/view');
});

test.each([
  ['https://example.com/reset/secret-token', 'https://example.com/reset/[redacted]'],
  ['https://example.com/invite/PrivateValue', 'https://example.com/invite/[redacted]'],
  ['https://example.com/users/alice%40example.com', 'https://example.com/users/[redacted]'],
  ['https://example.com/key/abcdefghijklmnopqrstuvwxyz012345', 'https://example.com/key/[redacted]'],
  ['https://example.com/key/ThisLooksLikeAnOpaqueLongToken', 'https://example.com/key/[redacted]'],
  ['https://example.com/a/token-private', 'https://example.com/a/[redacted]'],
  ['https://example.com/a/%3Cscript%3E', 'https://example.com/a/[redacted]'],
])('redacts sensitive path segments %s', (url, expected) => expect(sanitizedPageURL(url)).toBe(expected));

test('redacts known secret values and path copies of query values', () => {
  expect(sanitizedPageURL('https://example.com/project/my-private-key/view', ['my-private-key'])).toBe('https://example.com/project/[redacted]/view');
  expect(sanitizedPageURL('https://example.com/a/my-private-key?token=my-private-key')).toBe('https://example.com/a/[redacted]');
  expect(sanitizedPageURL('javascript:private')).toBe('');
});

test('structural diagnostics retain roles/types/counts and ancestor context, not free-text fields', () => {
  const input = { target: { tag: 'input', index: 4, childElementCount: 0, locator: 'html:nth-child(1) > input:nth-child(2)',
    attrs: { type: 'password', role: 'textbox', 'aria-disabled': 'false', value: 'private-value', placeholder: 'private-value', id: 'private-value', onclick: 'private-value' },
    text: 'private-value', currentValue: 'private-value', attributeNames: ['id', 'role', 'type', 'private-value'] },
    ancestors: [{ tag: 'div', attrs: { role: 'form', 'aria-expanded': 'true' }, childElementCount: 2, text: 'private-value' }],
    children: [] };
  const result = sanitizedDOMContext(input, null);
  expect(result.target).toMatchObject({ tag: 'input', attrs: { type: 'password', role: 'textbox', 'aria-disabled': 'false' }, attributeNames: ['id', 'role', 'type'] });
  expect(result.excerpt).toContain('<div role="form" aria-expanded="true">');
  expect(JSON.stringify(result)).not.toContain('private-value');
});

test('sanitizer rejects model selectors, arbitrary HTML and unknown structural values', () => {
  expect(safeLocator('#id')).toBeNull();
  expect(safeLocator('div[secret="value"]')).toBeNull();
  expect(safeLocator('html:nth-child(1) > body:nth-child(2) > div:nth-child(3)')).not.toBeNull();
  expect(safeLocator('secret-widget:nth-child(1)', ['secret-widget'])).toBeNull();
  const result = sanitizedDOMContext({ target: { tag: '<img src=secret>', attrs: { role: 'secret-role', type: 'secret-type', tabindex: 'secret', 'aria-hidden': 'secret' } } }, null);
  expect(result.target).toEqual({ tag: 'element', attrs: {}, attributeNames: [] });
  expect(JSON.stringify(result)).not.toContain('secret');
});

test('ancestor/children counts are bounded and rects copy numeric coordinates only', () => {
  const node = { tag: 'div', attrs: {} };
  const context = sanitizedDOMContext({ target: node, ancestors: Array(100).fill(node), children: Array(100).fill(node) }, null);
  expect(context.ancestors).toHaveLength(6); expect(context.children).toHaveLength(8);
  expect(safeRect({ x: 1, y: 2, w: 3, h: 4, secret: 'hidden' })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  expect(safeRect({ x: 'secret', y: 2, w: 3, h: 4 })).toBeNull();
});
