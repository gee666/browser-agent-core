(function () {
  'use strict';

  var SKIP_TAGS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD'];

  var INTERACTIVE_CURSORS = [
    'pointer', 'crosshair', 'grab', 'grabbing', 'cell', 'copy', 'move',
    'e-resize', 'n-resize', 's-resize', 'w-resize',
    'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  ];

  var INTERACTIVE_ROLES = [
    'button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'tab', 'switch', 'combobox', 'textbox', 'option',
    'searchbox', 'slider', 'spinbutton', 'treeitem',
  ];

  var COLLECT_ATTRS = [
    'id', 'type', 'placeholder', 'name', 'role', 'aria-label', 'aria-labelledby',
    'aria-describedby', 'aria-expanded', 'aria-selected', 'aria-current',
    'aria-checked', 'aria-haspopup', 'aria-controls', 'aria-readonly',
    'checked', 'value', 'alt', 'title', 'href', 'for', 'data-state',
    'data-testid', 'data-test-id', 'data-cy', 'tabindex', 'contenteditable',
  ];

  // Module-level WeakSet tracking elements seen in the previous extraction.
  var seenElements = new WeakSet();

  // Module-level Map: element index (number) → DOM element.
  // Populated on every getPageState() call so the executor can call
  // get_element_value message.
  var indexToElement = new Map();
  var contextMenuGuardTimer = null;
  var contextMenuGuard = null;

  function suppressNextContextMenu(timeoutMs) {
    if (contextMenuGuard) {
      document.removeEventListener('contextmenu', contextMenuGuard, true);
      clearTimeout(contextMenuGuardTimer);
    }
    contextMenuGuard = function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.removeEventListener('contextmenu', contextMenuGuard, true);
      clearTimeout(contextMenuGuardTimer);
      contextMenuGuard = null;
      contextMenuGuardTimer = null;
    };
    document.addEventListener('contextmenu', contextMenuGuard, true);
    contextMenuGuardTimer = setTimeout(function () {
      if (contextMenuGuard) document.removeEventListener('contextmenu', contextMenuGuard, true);
      contextMenuGuard = null;
      contextMenuGuardTimer = null;
    }, Math.max(100, Math.min(Number(timeoutMs) || 500, 1000)));
  }

  // ── 1. getBrowserContext ──────────────────────────────────────────────────

  function getBrowserContext() {
    return {
      screenX: window.screenX,
      screenY: window.screenY,
      outerHeight: window.outerHeight,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  // ── 2. isVisible ─────────────────────────────────────────────────────────

  function isSubtreeVisible(el) {
    if (!el || !el.isConnected) return false;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function isVisible(el) {
    if (!isSubtreeVisible(el)) return false;
    if (el.disabled) return false;
    var style = window.getComputedStyle(el);
    if (style.pointerEvents === 'none') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ── 3. getScrollInfo ─────────────────────────────────────────────────────

  function getScrollInfo(el) {
    var style = window.getComputedStyle(el);
    var overflowY = style.overflowY;
    var overflowX = style.overflowX;
    var scrollableY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
    var scrollableX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4;
    if (!scrollableY && !scrollableX) return null;
    return {
      top: el.scrollTop,
      bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
      left: el.scrollLeft,
      right: el.scrollWidth - el.clientWidth - el.scrollLeft,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function isPotentialStandaloneIcon(el) {
    if (!el || String(el.tagName).toUpperCase() !== 'SVG') return false;
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy') || '';
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    var name = (testId + ' ' + label).toLowerCase();
    return /\b(info|question|help)\b/.test(name) || /icon-(info|question|help)/.test(name);
  }

  function shouldSkip(el) {
    if (el.getAttribute('data-page-agent-ignore') === 'true') return true;
    if (el.getAttribute('aria-hidden') === 'true' && !isPotentialStandaloneIcon(el)) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (String(el.tagName).toUpperCase() === 'SVG' && isPotentialStandaloneIcon(el)) return false;
    return SKIP_TAGS.indexOf(el.tagName) !== -1;
  }

  function isInteractiveEl(el) {
    var tag = el.tagName;

    if (String(tag).toUpperCase() === 'SVG' && isPotentialStandaloneIcon(el)) return true;

    // Tag-based checks
    if (tag === 'A' && el.hasAttribute('href')) return true;
    if (tag === 'INPUT') {
      return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    }
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' ||
        tag === 'DETAILS' || tag === 'SUMMARY' || tag === 'LABEL') return true;

    // ARIA role
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.indexOf(role) !== -1) return true;

    // contenteditable
    if (el.getAttribute('contenteditable') === 'true' ||
        el.getAttribute('contenteditable') === 'plaintext-only') return true;

    // Keyboard-focusable custom controls. React/Grafana often implement
    // select values, menu entries, virtualized rows, and command-palette
    // triggers as div/span elements with tabindex instead of native controls.
    // Treat non-negative tabindex as interactive, but ignore anonymous focus
    // sentinels/containers that have no user-facing name, role, or text.
    var tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && /^-?\d+$/.test(tabindex) && parseInt(tabindex, 10) >= 0) {
      var hasInteractiveChild = false;
      try {
        hasInteractiveChild = !!el.querySelector('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable="true"],[contenteditable="plaintext-only"]');
      } catch (_) { /* ignore */ }

      var ariaFocusName = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
      var testFocusName = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy') || '';
      if (role) return true;
      if (ariaFocusName.replace(/\s+/g, '').length > 0) return true;
      if (testFocusName.replace(/\s+/g, '').length > 0 && !hasInteractiveChild) return true;

      // Plain tabindex is also useful for custom rows/options, but large focus
      // containers (Grafana side nav, panel wrappers, focus traps) often wrap
      // many real child controls. Do not swallow those descendants as one giant
      // element.
      var focusText = ((typeof el.innerText === 'string' ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim();
      if (focusText && focusText.length <= 120 && !hasInteractiveChild) return true;
    }

    // CSS cursor
    try {
      var cursor = window.getComputedStyle(el).cursor;
      if (INTERACTIVE_CURSORS.indexOf(cursor) !== -1) return true;
    } catch (e) { /* ignore */ }

    return false;
  }

  function textFromIdRefs(value) {
    if (!value) return '';
    var parts = value.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var id = parts[i];
      if (!id) continue;
      try {
        var ref = document.getElementById(id);
        if (ref) out.push(((typeof ref.innerText === 'string' ? ref.innerText : ref.textContent) || '').replace(/\s+/g, ' ').trim());
      } catch (_) { /* ignore invalid ids */ }
    }
    return out.filter(Boolean).join(' ');
  }

  function getAccessibleFallbackText(el) {
    var candidates = [
      el.getAttribute('aria-label'),
      textFromIdRefs(el.getAttribute('aria-labelledby')),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.getAttribute('alt'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
      el.getAttribute('data-cy'),
    ];

    // Grafana and other React apps frequently render icon-only buttons where
    // the useful name is on a child svg's data-testid (for example
    // icon-sync/RefreshPicker run button). Include it as a last-resort label so
    // the agent can distinguish blank-looking controls in the extractor output.
    try {
      var icon = el.querySelector('[data-testid], [data-test-id], [data-cy]');
      if (icon) {
        candidates.push(icon.getAttribute('data-testid') || icon.getAttribute('data-test-id') || icon.getAttribute('data-cy'));
      }
    } catch (_) { /* ignore */ }

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c) return String(c).replace(/^data-testid\s*/i, '').replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function isEditableControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName).toUpperCase();
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      return type !== 'hidden' && type !== 'button' && type !== 'submit' &&
        type !== 'reset' && type !== 'checkbox' && type !== 'radio' && type !== 'file';
    }
    if (tag === 'TEXTAREA') return true;
    return !!el.isContentEditable || el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === 'plaintext-only';
  }

  // ARIA combobox/textbox widgets frequently put the role on a wrapper while
  // the live value belongs to a nested input. The wrapper is the indexed and
  // clicked element, so always resolve it to the control that actually owns
  // the typed value before reporting or verifying that value.
  function resolveEditableControl(el) {
    if (isEditableControl(el)) return el;
    if (!el || el.nodeType !== 1) return null;

    var active = document.activeElement;
    if (active && active !== el && el.contains(active) && isEditableControl(active)) {
      return active;
    }

    var candidates;
    try {
      candidates = el.querySelectorAll(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
    } catch (_) {
      return null;
    }
    for (var i = 0; i < candidates.length; i++) {
      if (isEditableControl(candidates[i]) && isVisible(candidates[i])) return candidates[i];
    }
    return null;
  }

  function readEditableValue(el, allowSensitive) {
    var control = resolveEditableControl(el);
    if (!control) return null;
    var tag = String(control.tagName).toUpperCase();
    if (tag === 'INPUT') {
      var type = (control.getAttribute('type') || '').toLowerCase();
      if (!allowSensitive && type === 'password') return null;
      return typeof control.value === 'string' ? control.value : '';
    }
    if (tag === 'TEXTAREA') return typeof control.value === 'string' ? control.value : '';
    var text = (typeof control.innerText === 'string' ? control.innerText : '') || control.textContent || '';
    return text;
  }

  // ── 5. DOM tree walk ──────────────────────────────────────────────────────

  function buildElementInfo(el, depth, index) {
    var rect = el.getBoundingClientRect();
    var isNew = !seenElements.has(el);
    var scrollInfo = getScrollInfo(el);

    // Capture full visible text of the element (including text inside child
    // spans/divs).  innerText respects CSS visibility and skips SVG/script
    // nodes; fall back to textContent when innerText is unavailable (jsdom).
    var rawText = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
    var text = rawText.replace(/\s+/g, ' ').trim().slice(0, 80);

    // Collect HTML attributes
    var attrs = {};
    for (var j = 0; j < COLLECT_ATTRS.length; j++) {
      var attrName = COLLECT_ATTRS[j];
      var val = el.getAttribute(attrName);
      if (val !== null && val !== '') {
        attrs[attrName] = val.slice(0, 80);
      }
    }

    var inViewport = (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );

    // Capture the CURRENT user-entered content of form controls and
    // contenteditable surfaces so that downstream consumers (the agent LLM,
    // and especially the done-verification pass) can actually see what was
    // typed.  Without this, the verifier reads an empty-looking element
    // after a long `type` action and incorrectly concludes the input never
    // happened — text typed into a native <input>/<textarea> lives on
    // `.value`, not in innerText/textContent, and even contenteditable text
    // gets truncated to 80 chars in the label `text` field above.
    //
    // Stored separately from `text` so the existing label heuristics and
    // dedup logic keep working untouched.  The serializer renders this as
    // a `current-value="..."` attribute on the element line so the LLM
    // sees the value naturally alongside the other attributes.
    var currentValue = '';
    try {
      var _tag = el.tagName;
      var editableValue = readEditableValue(el, false);
      if (editableValue !== null) {
        currentValue = editableValue;
      } else if (_tag === 'INPUT') {
        var itype = (el.getAttribute('type') || '').toLowerCase();
        if (itype === 'checkbox' || itype === 'radio') {
          currentValue = el.checked ? 'checked' : '';
        }
      } else if (_tag === 'SELECT') {
        // Report the selected option's visible label, not its underlying value.
        var selOpt = el.options && el.options[el.selectedIndex];
        if (selOpt) {
          currentValue = (selOpt.textContent || selOpt.value || '').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (_) {
      currentValue = '';
    }
    if (currentValue) {
      // Collapse whitespace and cap at 500 chars so long replies survive into
      // the verifier's prompt without blowing up the DOM-text budget.  80
      // chars (the label cap) is far too short for real message content.
      currentValue = currentValue.replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    if (!text) {
      text = getAccessibleFallbackText(el).slice(0, 80);
    }

    return {
      index: index,
      tag: el.tagName.toLowerCase(),
      attrs: attrs,
      text: text,
      currentValue: currentValue,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      inViewport: inViewport,
      scrollInfo: scrollInfo,
      isNew: isNew,
      _domEl: el, // temporary; removed after seenElements update
    };
  }

  // Process a single element node (called from walkNode).
  function processElement(el, depth, state) {
    if (shouldSkip(el)) return;
    if (!isSubtreeVisible(el)) return;

    if (isInteractiveEl(el) && isVisible(el)) {
      var info = buildElementInfo(el, depth, state.nextIndex++);
      state.elements.push(info);
      state.lines.push({ type: 'element', depth: depth, element: info });
      // Do NOT recurse into children of interactive elements.
      // Inner <span>/<svg>/icon nodes are visual decoration for the same
      // clickable unit; giving them separate indices doubles the index count
      // and makes the representation unreadable (especially on React SPAs
      // like Suno where every button wraps its label in a <span> that
      // inherits cursor:pointer and would otherwise get its own index).
      // Full text content is already captured via innerText above.
    } else {
      // Pass-through: non-interactive or non-clickable containers still need
      // recursion. Grafana/React Data Grid often puts useful links/buttons
      // inside wrappers with pointer-events:none, zero-sized measuring cells,
      // or non-interactive ARIA grid rows; pruning the whole subtree here hides
      // trace rows, attribute filters, and open-in-new-tab links.
      walkNode(el, depth, state);
    }
  }

  // DFS walk of a node's children.
  function walkNode(node, depth, state) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) { // TEXT_NODE
        var text = child.textContent.trim();
        if (text) state.lines.push({ type: 'text', depth: depth, text: text });
      } else if (child.nodeType === 1) { // ELEMENT_NODE
        processElement(child, depth, state);
      }
    }
  }

  // ── 6. flatTreeToString ───────────────────────────────────────────────────

  function buildDomText(state) {
    var scrollY = window.scrollY;
    var viewportHeight = window.innerHeight;
    var pageHeight = document.documentElement.scrollHeight;

    var str = '[Start of page]\n';

    for (var i = 0; i < state.lines.length; i++) {
      var line = state.lines[i];
      var indent = '';
      for (var d = 0; d < line.depth; d++) indent += '\t';

      if (line.type === 'text') {
        str += indent + line.text + '\n';
      } else {
        var el = line.element;

        // Build attribute string
        var attrsStr = '';
        var attrKeys = Object.keys(el.attrs);
        for (var j = 0; j < attrKeys.length; j++) {
          attrsStr += ' ' + attrKeys[j] + '="' + el.attrs[attrKeys[j]] + '"';
        }
        // Surface the current user-entered value for form controls and
        // contenteditable surfaces so the LLM (and the done-verification
        // pass) can actually see what was typed.  Escape embedded double
        // quotes so the pseudo-HTML stays well-formed.
        if (el.currentValue) {
          var cvEsc = el.currentValue.replace(/"/g, '&quot;');
          attrsStr += ' current-value="' + cvEsc + '"';
        }
        if (el.scrollInfo) {
          var si = el.scrollInfo;
          attrsStr += ' data-scrollable="top=' + si.top + ', bottom=' + si.bottom +
            ', left=' + si.left + ', right=' + si.right + '"';
        }

        var prefix = el.isNew ? '*' : '';
        str += indent + prefix + '[' + el.index + ']<' + el.tag + attrsStr + '>' + el.text + '</' + el.tag + '>\n';
      }
    }

    // Scroll position footer
    if (scrollY > 0) {
      var pagesAbove = Math.round(scrollY / viewportHeight * 10) / 10;
      str += '... ' + pagesAbove + ' pages above\n';
    }
    if (pageHeight > scrollY + viewportHeight + 10) {
      var pagesBelow = Math.round((pageHeight - scrollY - viewportHeight) / viewportHeight * 10) / 10;
      str += '... ' + pagesBelow + ' pages below \u2014 scroll to see more\n';
    }

    str += '[End of visible area]\n';
    return str;
  }

  // ── 7. waitForSettle ──────────────────────────────────────────────────────

  function waitForSettle(quietMs) {
    return new Promise(function (resolve) {
      var timer = null;
      var hardTimer = null;

      function done() {
        clearTimeout(timer);
        clearTimeout(hardTimer);
        observer.disconnect();
        resolve();
      }

      var observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      timer = setTimeout(done, quietMs);
      hardTimer = setTimeout(done, quietMs * 4);
    });
  }

  // ── 8. getPageState ───────────────────────────────────────────────────────

  function getPageState() {
    var state = { elements: [], lines: [], nextIndex: 0 };
    walkNode(document.body, 0, state);

    // Update seenElements and indexToElement to the current extraction's set.
    var newSeen = new WeakSet();
    var newIndexToElement = new Map();
    for (var i = 0; i < state.elements.length; i++) {
      var info = state.elements[i];
      newSeen.add(info._domEl);
      newIndexToElement.set(info.index, info._domEl);
      delete info._domEl;
    }
    seenElements = newSeen;
    indexToElement = newIndexToElement;

    var domText = buildDomText(state);

    return {
      url: location.href,
      title: document.title,
      domText: domText,
      elements: state.elements,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      context: getBrowserContext(),
    };
  }

  // ── Message listener ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'get_page_state') {
      sendResponse(getPageState());
      return true;
    }
    if (message.type === 'wait_for_settle') {
      waitForSettle(500).then(function () {
        sendResponse({ settled: true });
      });
      return true;
    }
    if (message.type === 'suppress_context_menu_once') {
      suppressNextContextMenu(message.timeoutMs);
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'focus_element') {
      var fel = indexToElement.get(message.index);
      var control = fel && fel.isConnected ? (resolveEditableControl(fel) || fel) : null;
      if (!control || typeof control.focus !== 'function') {
        sendResponse({ ok: false });
      } else {
        try {
          control.focus({ preventScroll: true });
          sendResponse({ ok: document.activeElement === control });
        } catch (_) {
          sendResponse({ ok: false });
        }
      }
      return true;
    }
    if (message.type === 'get_element_value') {
      var vel = indexToElement.get(message.index);
      // React editors may replace the indexed wrapper while preserving focus
      // on the replacement control. Prefer that live focused control rather
      // than declaring the value unreadable or rebuilding unstable indices.
      if (!vel || !vel.isConnected) {
        vel = isEditableControl(document.activeElement) ? document.activeElement : null;
      }
      if (!vel) {
        sendResponse({ ok: false, value: null, reason: 'not found' });
      } else {
        var liveControl = resolveEditableControl(vel);
        var liveType = liveControl && String(liveControl.tagName).toUpperCase() === 'INPUT'
          ? (liveControl.getAttribute('type') || '').toLowerCase()
          : '';
        if (liveType === 'password') {
          sendResponse({ ok: false, value: null, reason: 'sensitive' });
        } else {
          var val = readEditableValue(vel, false);
          if (val === null) {
            sendResponse({ ok: false, value: null, reason: 'value unavailable' });
          } else {
            sendResponse({ ok: true, value: typeof val === 'string' ? val.replace(/\u200B|\u200C|\u200D|\uFEFF/g, '') : val });
          }
        }
      }
      return true;
    }
  });

})();
