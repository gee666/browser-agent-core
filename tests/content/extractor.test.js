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

/** Default non-zero rect so visibility checks pass. */
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
  // Set a viewport size so inViewport calculations work predictably.
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });

  // jsdom does not implement innerText (it depends on CSS layout). Polyfill with textContent.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent ?? '';
    },
    configurable: true,
  });

  // jsdom may not expose CSS.escape as a plain global inside eval'd code.
  if (typeof globalThis.CSS === 'undefined') {
    globalThis.CSS = {
      escape: (str) =>
        String(str).replace(/[^\w-]/g, (ch) => `\\${ch.codePointAt(0).toString(16).padStart(6, '0')} `),
    };
  }

  // Evaluate the IIFE once — it registers the onMessage listener on the mocked chrome.
  loadExtractor();
  messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
});

beforeEach(() => {
  document.body.innerHTML = '';

  // Make all elements visually non-zero by default so the rect check passes.
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ ...VISIBLE_RECT });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Invoke the get_page_state handler and return the synchronous response. */
function getPageState() {
  let response;
  messageHandler({ type: 'get_page_state' }, {}, (r) => {
    response = r;
  });
  return response;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('extractor', () => {
  test('test_button_extracted', () => {
    document.body.innerHTML = '<button>Click me</button>';
    const { elements } = getPageState();
    expect(elements).toContainEqual(
      expect.objectContaining({ tag: 'BUTTON', text: 'Click me', role: 'button', enabled: true }),
    );
  });

  test('test_input_with_for_label', () => {
    document.body.innerHTML = '<label for="e">Email</label><input id="e" type="email">';
    const { elements } = getPageState();
    const input = elements.find((el) => el.tag === 'INPUT');
    expect(input).toBeDefined();
    expect(input.label).toBe('Email');
  });

  test('test_input_with_aria_label', () => {
    document.body.innerHTML = '<input aria-label="Search">';
    const { elements } = getPageState();
    expect(elements[0].label).toBe('Search');
  });

  test('test_input_with_aria_labelledby', () => {
    document.body.innerHTML = '<span id="s">Username</span><input aria-labelledby="s">';
    const { elements } = getPageState();
    const input = elements.find((el) => el.tag === 'INPUT');
    expect(input.label).toBe('Username');
  });

  test('test_input_with_placeholder_fallback', () => {
    document.body.innerHTML = '<input placeholder="Enter email">';
    const { elements } = getPageState();
    expect(elements[0].label).toBe('Enter email');
  });

  test('test_hidden_element_excluded', () => {
    document.body.innerHTML = '<button style="display:none">Hidden</button>';
    const { elements } = getPageState();
    expect(elements.find((el) => el.text === 'Hidden')).toBeUndefined();
  });

  test('test_visibility_hidden_excluded', () => {
    document.body.innerHTML = '<button style="visibility:hidden">Invisible</button>';
    const { elements } = getPageState();
    expect(elements.find((el) => el.text === 'Invisible')).toBeUndefined();
  });

  test('test_zero_size_excluded', () => {
    document.body.innerHTML = '<button>Zero</button>';

    // Override default mock with zero rect for this test.
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });

    const { elements } = getPageState();
    expect(elements.find((el) => el.text === 'Zero')).toBeUndefined();
  });

  test('test_disabled_included_but_flagged', () => {
    document.body.innerHTML = '<button disabled>Disabled</button>';
    const { elements } = getPageState();
    // Find by tag since innerText-based text field maps to textContent via polyfill.
    const btn = elements.find((el) => el.tag === 'BUTTON' && el.text === 'Disabled');
    expect(btn).toBeDefined();
    expect(btn.enabled).toBe(false);
  });

  test('test_select_extracted', () => {
    document.body.innerHTML = '<select><option>A</option></select>';
    const { elements } = getPageState();
    expect(elements).toContainEqual(
      expect.objectContaining({ tag: 'SELECT', role: 'combobox' }),
    );
  });

  test('test_contenteditable_extracted', () => {
    document.body.innerHTML = '<div contenteditable="true">editable</div>';
    const { elements } = getPageState();
    expect(elements).toContainEqual(expect.objectContaining({ role: 'textbox' }));
  });

  test('test_inviewport_true_for_visible', () => {
    document.body.innerHTML = '<button>In Viewport</button>';
    // Default rect: top=10, left=10, well inside 1024×768.
    const { elements } = getPageState();
    const btn = elements.find((el) => el.tag === 'BUTTON' && el.text === 'In Viewport');
    expect(btn).toBeDefined();
    expect(btn.inViewport).toBe(true);
  });

  test('test_inviewport_false_for_below_fold', () => {
    document.body.innerHTML = '<button>Below Fold</button>';
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 40,
      top: 2000,
      bottom: 2040,
      left: 10,
      right: 110,
    });
    const { elements } = getPageState();
    const btn = elements.find((el) => el.tag === 'BUTTON' && el.text === 'Below Fold');
    expect(btn).toBeDefined();
    expect(btn.inViewport).toBe(false);
  });

  test('test_get_page_state_shape', () => {
    const response = getPageState();
    for (const key of [
      'url',
      'title',
      'elements',
      'context',
      'viewportWidth',
      'viewportHeight',
      'pageWidth',
      'pageHeight',
    ]) {
      expect(response).toHaveProperty(key);
    }
  });

  test('test_duplicate_elements_deduped', () => {
    // This element matches both the 'button' selector and '[role=button]'.
    document.body.innerHTML = '<button role="button">Test</button>';
    const { elements } = getPageState();
    // With innerText polyfill, text field equals textContent.
    const matches = elements.filter((el) => el.tag === 'BUTTON' && el.text === 'Test');
    expect(matches).toHaveLength(1);
  });

  test('test_deeply_nested_label', () => {
    document.body.innerHTML = '<label><span>Name</span><input type="text"></label>';
    const { elements } = getPageState();
    const input = elements.find((el) => el.tag === 'INPUT');
    expect(input).toBeDefined();
    // The extractor walks up to the ancestor <label> and uses its textContent.
    expect(input.label).toBe('Name');
  });
});
