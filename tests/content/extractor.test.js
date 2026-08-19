import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadExtractor() {
  const code = readFileSync(join(__dirname, '../../content/extractor.js'), 'utf-8');
  // eslint-disable-next-line no-eval
  eval(code);
}

// ── shared helpers ────────────────────────────────────────────────────────────

const VISIBLE_RECT = {
  width: 100,
  height: 40,
  top: 10,
  bottom: 50,
  left: 10,
  right: 110,
};

let messageHandler;

beforeAll(() => {
  Object.defineProperty(window, 'innerWidth',  { value: 1024, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768,  writable: true, configurable: true });

  // jsdom does not implement innerText; polyfill with textContent.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    get() { return this.textContent ?? ''; },
    configurable: true,
  });

  if (typeof globalThis.CSS === 'undefined') {
    globalThis.CSS = {
      escape: (str) =>
        String(str).replace(/[^\w-]/g, (ch) => `\\${ch.codePointAt(0).toString(16).padStart(6, '0')} `),
    };
  }

  loadExtractor();
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
});

beforeEach(() => {
  document.body.innerHTML = '';
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ ...VISIBLE_RECT });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Invoke get_page_state and return the synchronous response. */
function getPageState() {
  let response;
  messageHandler({ type: 'get_page_state' }, {}, (r) => { response = r; });
  return response;
}

function getElementValue(index) {
  let response;
  messageHandler({ type: 'get_element_value', index }, {}, (r) => { response = r; });
  return response;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('extractor', () => {

  // 1. button appears as [N]<button>text</button> in domText
  test('test_domText_contains_button_with_index', () => {
    document.body.innerHTML = '<button>Click me</button>';
    const { domText } = getPageState();
    // May be prefixed with '*' if element is new — '[0]<button>Click me</button>' is a substring either way
    expect(domText).toContain('[0]<button>Click me</button>');
  });

  // 2. rect uses .w and .h keys, not .width / .height
  test('test_elements_array_has_rect_with_w_h', () => {
    document.body.innerHTML = '<button>Test</button>';
    const { elements } = getPageState();
    expect(elements.length).toBeGreaterThan(0);
    expect(elements[0].rect).toHaveProperty('w');
    expect(elements[0].rect).toHaveProperty('h');
    expect(elements[0].rect).not.toHaveProperty('width');
    expect(elements[0].rect).not.toHaveProperty('height');
  });

  // 3. new element marked with '*'; same element on subsequent call is not new
  test('test_new_element_marked_with_star', () => {
    document.body.innerHTML = '<button>Old</button>';

    // First call: element has never been seen → isNew: true → '*[0]' in domText
    let state = getPageState();
    expect(state.elements[0].isNew).toBe(true);
    expect(state.domText).toContain('*[0]');

    // Second call: same DOM element is now in seenElements → isNew: false
    state = getPageState();
    expect(state.elements[0].isNew).toBe(false);
    expect(state.domText).not.toContain('*[0]');

    // Append a brand-new element; it has never been seen
    const newBtn = document.createElement('button');
    newBtn.textContent = 'New';
    document.body.appendChild(newBtn);

    state = getPageState();
    const newEl = state.elements.find((e) => e.text === 'New');
    expect(newEl).toBeDefined();
    expect(newEl.isNew).toBe(true);
    expect(state.domText).toContain('*[1]');
  });

  // 4. element with scrollHeight > clientHeight + 4 and overflow:auto gets scrollInfo
  test('test_scrollable_element_has_scroll_info', () => {
    document.body.innerHTML = '<button>Scroll</button>';
    const btn = document.querySelector('button');

    Object.defineProperty(btn, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(btn, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(btn, 'scrollTop',    { value: 0,   configurable: true });
    Object.defineProperty(btn, 'scrollWidth',  { value: 100, configurable: true });
    Object.defineProperty(btn, 'clientWidth',  { value: 100, configurable: true });

    jest.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block', visibility: 'visible', pointerEvents: 'auto',
      cursor: 'default', overflowY: 'auto', overflowX: 'visible',
    });

    const { elements } = getPageState();
    expect(elements.length).toBeGreaterThan(0);
    expect(elements[0].scrollInfo).not.toBeNull();
    // bottom = scrollHeight(500) − clientHeight(100) − scrollTop(0) = 400
    expect(elements[0].scrollInfo.bottom).toBe(400);
  });

  // 5. response has a domText string field
  test('test_get_page_state_has_domText', () => {
    const state = getPageState();
    expect(state).toHaveProperty('domText');
    expect(typeof state.domText).toBe('string');
  });

  // 6. response has an elements array field
  test('test_get_page_state_has_elements', () => {
    const state = getPageState();
    expect(state).toHaveProperty('elements');
    expect(Array.isArray(state.elements)).toBe(true);
  });

  // 7. element with display:none is excluded
  test('test_hidden_element_excluded', () => {
    // jsdom handles inline display:none in getComputedStyle natively; no mock needed
    document.body.innerHTML = '<button style="display:none">Hidden</button>';
    const { elements } = getPageState();
    expect(elements.find((e) => e.text === 'Hidden')).toBeUndefined();
  });

  // 8. element inside viewport has inViewport: true
  test('test_inviewport_true_for_visible', () => {
    document.body.innerHTML = '<button>In Viewport</button>';
    // Default rect: top=10, bottom=50 — well inside 1024×768
    const { elements } = getPageState();
    const btn = elements.find((e) => e.text === 'In Viewport');
    expect(btn).toBeDefined();
    expect(btn.inViewport).toBe(true);
  });

  // 9. element below the fold has inViewport: false
  test('test_inviewport_false_for_below_fold', () => {
    document.body.innerHTML = '<button>Below Fold</button>';
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 40, top: 2000, bottom: 2040, left: 10, right: 110,
    });
    const { elements } = getPageState();
    const btn = elements.find((e) => e.text === 'Below Fold');
    expect(btn).toBeDefined();
    expect(btn.inViewport).toBe(false);
  });

  // 10. div with role=button is extracted as an interactive element
  test('test_interactive_by_aria_role', () => {
    document.body.innerHTML = '<div role="button">Custom Button</div>';
    const { elements } = getPageState();
    expect(elements.length).toBeGreaterThan(0);
    expect(elements[0].tag).toBe('div');
    expect(elements[0].attrs.role).toBe('button');
  });

  // 11. multiple siblings get sequential indices 0, 1, 2 in DFS order
  test('test_index_assignment_sequential', () => {
    document.body.innerHTML = '<button>A</button><button>B</button><button>C</button>';
    const { elements } = getPageState();
    expect(elements).toHaveLength(3);
    expect(elements[0].index).toBe(0);
    expect(elements[1].index).toBe(1);
    expect(elements[2].index).toBe(2);
  });

  test('test_context_menu_guard_prevents_only_the_next_context_menu', () => {
    let response;
    messageHandler({ type: 'suppress_context_menu_once', timeoutMs: 1200 }, {}, (r) => { response = r; });
    expect(response).toEqual({ ok: true });

    const first = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);

    const second = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  // 12. wait_for_settle message resolves with { settled: true }
  test('test_wait_for_settle_resolves', async () => {
    let settled = null;
    messageHandler({ type: 'wait_for_settle' }, {}, (r) => { settled = r; });
    // waitForSettle(500) fires after 500 ms; wait 600 ms to be safe
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toEqual({ settled: true });
  }, 10000);

  // ── current-value surfacing (done-verification fix) ────────────────────────
  // Guards against a regression where the verifier thinks a typed field is
  // empty because .value is not part of innerText/textContent.

  test('test_textarea_value_surfaced_in_element_and_domText', () => {
    document.body.innerHTML = '<textarea>Hello there, thanks for reaching out!</textarea>';
    const state = getPageState();
    const ta = state.elements.find((e) => e.tag === 'textarea');
    expect(ta).toBeDefined();
    expect(ta.currentValue).toBe('Hello there, thanks for reaching out!');
    expect(state.domText).toContain('current-value="Hello there, thanks for reaching out!"');
  });

  test('test_input_text_value_surfaced', () => {
    document.body.innerHTML = '<input type="text" placeholder="Search" />';
    document.querySelector('input').value = 'laptops on sale';
    const state = getPageState();
    const input = state.elements.find((e) => e.tag === 'input');
    expect(input.currentValue).toBe('laptops on sale');
    expect(state.domText).toContain('current-value="laptops on sale"');
  });

  test('test_input_password_value_is_never_surfaced', () => {
    document.body.innerHTML = '<input type="password" />';
    document.querySelector('input').value = 'hunter2';
    const state = getPageState();
    const input = state.elements.find((e) => e.tag === 'input');
    expect(input).toBeDefined();
    expect(input.currentValue).toBe('');
    expect(state.domText).not.toContain('hunter2');
    expect(getElementValue(input.index)).toEqual({ ok: false, value: null, reason: 'sensitive' });
  });

  test('test_aria_combobox_wrapper_reads_nested_input_value', () => {
    document.body.innerHTML =
      '<div role="combobox" aria-label="City"><input type="text" /></div>';
    document.querySelector('input').value = 'Amsterdam';

    const state = getPageState();
    const wrapper = state.elements.find((e) => e.attrs.role === 'combobox');
    expect(wrapper).toBeDefined();
    expect(wrapper.currentValue).toBe('Amsterdam');
    expect(state.domText).toContain('current-value="Amsterdam"');
    expect(getElementValue(wrapper.index)).toEqual({ ok: true, value: 'Amsterdam' });

    let focusResponse;
    messageHandler({ type: 'focus_element', index: wrapper.index }, {}, (r) => { focusResponse = r; });
    expect(focusResponse).toEqual({ ok: true });
    expect(document.activeElement).toBe(document.querySelector('input'));
  });

  test('test_hidden_nested_control_is_not_used_for_wrapper_value', () => {
    document.body.innerHTML =
      '<div role="combobox"><span style="display:none"><input value="hidden"></span><input value="visible"></div>';
    const state = getPageState();
    const wrapper = state.elements.find((e) => e.attrs.role === 'combobox');
    expect(wrapper.currentValue).toBe('visible');
    expect(getElementValue(wrapper.index)).toEqual({ ok: true, value: 'visible' });
  });

  test('test_focused_editable_descendant_wins_inside_composite_wrapper', () => {
    document.body.innerHTML =
      '<div role="textbox"><input value="first"><textarea>second</textarea></div>';
    const textarea = document.querySelector('textarea');
    textarea.value = 'focused value';
    textarea.focus();

    const state = getPageState();
    const wrapper = state.elements.find((e) => e.attrs.role === 'textbox');
    expect(wrapper.currentValue).toBe('focused value');
    expect(getElementValue(wrapper.index)).toEqual({ ok: true, value: 'focused value' });
  });

  // The root cause of the Gmail-reply verification failure: the label slice
  // cap of 80 chars wiped out the evidence the reply was typed.
  test('test_long_textarea_value_is_not_truncated_at_80_chars', () => {
    const longReply =
      'Thank you for reaching out about the project — I am excited to help. ' +
      'Let me share a few thoughts on the timeline, the deliverables, and the ' +
      'review process so we can align before next week, including a draft ' +
      'proposal and a rough schedule.';
    expect(longReply.length).toBeGreaterThan(200);
    document.body.innerHTML = '<textarea></textarea>';
    document.querySelector('textarea').value = longReply;
    const state = getPageState();
    const ta = state.elements.find((e) => e.tag === 'textarea');
    expect(ta.currentValue).toBe(longReply);
    expect(state.domText).toContain(longReply);
  });

  // Gmail's reply compose box is a contenteditable div, not a textarea;
  // without this, the verifier saw nothing after a successful `type`.
  test('test_contenteditable_value_surfaced', () => {
    document.body.innerHTML =
      '<div role="textbox" contenteditable="true" aria-label="Message Body">' +
      'Hi Alice, thanks for the update!' +
      '</div>';
    const state = getPageState();
    const box = state.elements.find((e) => e.attrs && e.attrs['aria-label'] === 'Message Body');
    expect(box).toBeDefined();
    expect(box.currentValue).toBe('Hi Alice, thanks for the update!');
    expect(state.domText).toContain('current-value="Hi Alice, thanks for the update!"');
  });

  test('test_empty_textarea_has_no_current_value_attribute', () => {
    document.body.innerHTML = '<textarea placeholder="Reply"></textarea>';
    const state = getPageState();
    expect(state.domText).not.toContain('current-value=');
  });

  test('test_current_value_escapes_double_quotes', () => {
    document.body.innerHTML = '<input type="text" />';
    document.querySelector('input').value = 'She said "hello" twice';
    const state = getPageState();
    expect(state.domText).toContain('current-value="She said &quot;hello&quot; twice"');
  });

  test('test_focusable_grafana_custom_select_is_extracted', () => {
    document.body.innerHTML =
      '<div tabindex="0" data-testid="data-testid Dashboard template variables Variable Value DropDown value link text tempo">' +
      'Tempo</div>';
    const state = getPageState();
    const select = state.elements.find((e) => e.text === 'Tempo');
    expect(select).toBeDefined();
    expect(select.attrs.tabindex).toBe('0');
    expect(select.attrs['data-testid']).toContain('Dashboard template variables');
  });

  test('test_icon_only_button_uses_testid_fallback_text', () => {
    document.body.innerHTML =
      '<button type="button" data-testid="data-testid RefreshPicker run button">' +
      '<svg data-testid="icon-sync" aria-hidden="true"></svg>' +
      '</button>';
    const state = getPageState();
    const btn = state.elements.find((e) => e.tag === 'button');
    expect(btn).toBeDefined();
    expect(btn.text).toBe('RefreshPicker run button');
    expect(state.domText).toContain('RefreshPicker run button');
  });

  test('test_aria_labelledby_fallback_text_for_blank_control', () => {
    document.body.innerHTML =
      '<span id="trace-label">Trace ID</span>' +
      '<div role="button" aria-labelledby="trace-label"></div>';
    const state = getPageState();
    const btn = state.elements.find((e) => e.attrs.role === 'button');
    expect(btn).toBeDefined();
    expect(btn.text).toBe('Trace ID');
  });

  test('test_treeitem_role_is_interactive_for_virtualized_rows', () => {
    document.body.innerHTML = '<div role="treeitem" aria-selected="true">resource.service.name</div>';
    const state = getPageState();
    const row = state.elements.find((e) => e.attrs.role === 'treeitem');
    expect(row).toBeDefined();
    expect(row.attrs['aria-selected']).toBe('true');
  });

  test('test_noninteractive_grid_row_does_not_swallow_trace_link', () => {
    document.body.innerHTML =
      '<div role="grid">' +
      '<div role="row" aria-rowindex="2">' +
      '<div role="gridcell">ramcore</div>' +
      '<div role="gridcell"><a href="/explore?trace=abc" title="Open in new tab">http get /api/v1/projects/{projectId}/status</a></div>' +
      '</div>' +
      '</div>';
    const state = getPageState();
    expect(state.elements.some((e) => e.attrs.role === 'row')).toBe(false);
    const trace = state.elements.find((e) => e.tag === 'a' && e.text.includes('/projects/{projectId}/status'));
    expect(trace).toBeDefined();
    expect(trace.attrs.title).toBe('Open in new tab');
  });

  test('test_pointer_events_none_wrapper_still_recurses_to_clickable_child', () => {
    document.body.innerHTML = '<div class="wrapper"><a href="/trace/1">Open trace</a></div>';
    jest.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: el.className === 'wrapper' ? 'none' : 'auto',
      cursor: 'default',
      overflowY: 'visible',
      overflowX: 'visible',
    }));
    const state = getPageState();
    const link = state.elements.find((e) => e.text === 'Open trace');
    expect(link).toBeDefined();
    expect(link.attrs.href).toBe('/trace/1');
  });

  test('test_standalone_grafana_info_icon_is_extracted_even_when_aria_hidden', () => {
    document.body.innerHTML = '<svg data-testid="icon-info-circle" aria-hidden="true"></svg>';
    jest.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...VISIBLE_RECT });
    const state = getPageState();
    const icon = state.elements.find((e) => e.tag === 'svg');
    expect(icon).toBeDefined();
    expect(icon.attrs['data-testid']).toBe('icon-info-circle');
    expect(icon.text).toBe('icon-info-circle');
  });

});
