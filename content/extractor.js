(function () {
  'use strict';

  var SKIP_TAGS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD'];

  var INTERACTIVE_CURSORS = [
    'pointer', 'text', 'crosshair', 'grab', 'grabbing', 'cell', 'copy', 'move',
    'e-resize', 'n-resize', 's-resize', 'w-resize',
    'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  ];

  var INTERACTIVE_ROLES = [
    'button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch',
    'combobox', 'textbox', 'option', 'searchbox', 'slider', 'spinbutton',
  ];

  var COLLECT_ATTRS = [
    'type', 'placeholder', 'name', 'role', 'aria-label', 'aria-expanded',
    'aria-checked', 'aria-haspopup', 'checked', 'value', 'alt', 'title',
    'href', 'for', 'data-state', 'contenteditable',
  ];

  // Module-level WeakSet tracking elements seen in the previous extraction.
  var seenElements = new WeakSet();

  // Module-level Map: element index (number) → DOM element.
  // Populated on every getPageState() call so the executor can call
  // scrollIntoView on the real DOM node via the scroll_to_index message.
  var indexToElement = new Map();

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

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
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

  function shouldSkip(el) {
    if (el.getAttribute('data-page-agent-ignore') === 'true') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    return SKIP_TAGS.indexOf(el.tagName) !== -1;
  }

  function isInteractiveEl(el) {
    var tag = el.tagName;

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
    if (el.getAttribute('contenteditable') === 'true') return true;

    // CSS cursor
    try {
      var cursor = window.getComputedStyle(el).cursor;
      if (INTERACTIVE_CURSORS.indexOf(cursor) !== -1) return true;
    } catch (e) { /* ignore */ }

    return false;
  }

  // ── 5. DOM tree walk ──────────────────────────────────────────────────────

  function buildElementInfo(el, depth, index) {
    var rect = el.getBoundingClientRect();
    var isNew = !seenElements.has(el);
    var scrollInfo = getScrollInfo(el);

    // Direct text from TEXT_NODE children only
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) {
        text += el.childNodes[i].textContent;
      }
    }
    text = text.trim().slice(0, 80);

    // Collect HTML attributes
    var attrs = {};
    for (var j = 0; j < COLLECT_ATTRS.length; j++) {
      var attrName = COLLECT_ATTRS[j];
      var val = el.getAttribute(attrName);
      if (val !== null && val !== '') {
        attrs[attrName] = val.slice(0, 40);
      }
    }

    var inViewport = (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );

    return {
      index: index,
      tag: el.tagName.toLowerCase(),
      attrs: attrs,
      text: text,
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
    if (!isVisible(el)) return;

    if (isInteractiveEl(el)) {
      var info = buildElementInfo(el, depth, state.nextIndex++);
      state.elements.push(info);
      state.lines.push({ type: 'element', depth: depth, element: info });
      // Recurse into children at depth+1; skip text nodes (already in .text)
      for (var i = 0; i < el.childNodes.length; i++) {
        var child = el.childNodes[i];
        if (child.nodeType === 1) {
          processElement(child, depth + 1, state);
        }
      }
    } else {
      // Pass-through: non-interactive container, recurse at same depth
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
    if (message.type === 'scroll_to_index') {
      var el = indexToElement.get(message.index);
      if (el && el.isConnected) {
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: 'element not found or disconnected' });
      }
      return true;
    }
    if (message.type === 'focus_element') {
      var fel = indexToElement.get(message.index);
      if (fel && fel.isConnected) {
        fel.focus({ preventScroll: true });
        // For contenteditable, also move the caret to the end so Ctrl+A
        // selects the element's own content, not the whole page.
        if (fel.isContentEditable) {
          var range = document.createRange();
          range.selectNodeContents(fel);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: 'element not found or disconnected' });
      }
      return true;
    }
    if (message.type === 'get_element_value') {
      var vel = indexToElement.get(message.index);
      if (!vel || !vel.isConnected) {
        sendResponse({ ok: false, value: null, reason: 'not found' });
      } else {
        // inputs and textareas expose .value; contenteditable and others use textContent
        var val = ('value' in vel) ? vel.value : (vel.textContent || vel.innerText || '');
        sendResponse({ ok: true, value: val });
      }
      return true;
    }
  });

})();
