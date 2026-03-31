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

  // 12. wait_for_settle message resolves with { settled: true }
  test('test_wait_for_settle_resolves', async () => {
    let settled = null;
    messageHandler({ type: 'wait_for_settle' }, {}, (r) => { settled = r; });
    // waitForSettle(500) fires after 500 ms; wait 600 ms to be safe
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toEqual({ settled: true });
  }, 10000);

});
