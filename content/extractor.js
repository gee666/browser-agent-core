(function () {
  'use strict';

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

  function getElementLabel(el) {
    // 1. aria-labelledby → collect textContent of each referenced element
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ids = labelledBy.trim().split(/\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = document.getElementById(ids[i]);
        if (ref) {
          var text = ref.textContent.trim();
          if (text) parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join(' ');
    }

    // 2. aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    // 3. <label for="..."> matching el.id
    if (el.id) {
      var forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel) {
        var forText = forLabel.textContent.trim();
        if (forText) return forText;
      }
    }

    // 4. Closest ancestor <label>
    var ancestor = el.parentElement;
    while (ancestor) {
      if (ancestor.tagName === 'LABEL') {
        var ancestorText = ancestor.textContent.trim();
        if (ancestorText) return ancestorText;
        break;
      }
      ancestor = ancestor.parentElement;
    }

    // 5. placeholder
    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();

    // 6. title
    if (el.title && el.title.trim()) return el.title.trim();

    // 7. alt (for <img>, <input type=image>)
    var tag = el.tagName;
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) {
      if (el.alt && el.alt.trim()) return el.alt.trim();
    }

    // 8. innerText (for buttons, links)
    if (el.innerText) {
      var innerText = el.innerText.trim().substring(0, 120);
      if (innerText) return innerText;
    }

    // 9. null
    return null;
  }

  function isVisible(el, rect) {
    // Rect must have non-zero dimensions
    if (rect.width <= 0 || rect.height <= 0) return false;

    var style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) <= 0) return false;

    // Walk up ancestors
    var parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      var parentStyle = getComputedStyle(parent);
      if (parentStyle.display === 'none') return false;
      if (parentStyle.visibility === 'hidden') return false;
      parent = parent.parentElement;
    }

    return true;
  }

  function isInViewport(rect) {
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  function inferRole(el) {
    var tag = el.tagName;

    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';

    if (tag === 'INPUT') {
      var type = (el.type || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }

    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';

    if (el.hasAttribute('contenteditable')) return 'textbox';

    return 'generic';
  }

  function extractInteractiveElements() {
    var selector = [
      'a[href]',
      'button',
      'input:not([type=hidden])',
      'select',
      'textarea',
      '[role=button]',
      '[role=link]',
      '[role=checkbox]',
      '[role=radio]',
      '[role=menuitem]',
      '[role=tab]',
      '[role=option]',
      '[role=combobox]',
      '[role=searchbox]',
      '[role=textbox]',
      '[role=switch]',
      '[role=spinbutton]',
      '[contenteditable=true]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    var nodes = document.querySelectorAll(selector);
    var seen = new Set();
    var results = [];
    var index = 0;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];

      // Deduplicate by element reference
      if (seen.has(el)) continue;
      seen.add(el);

      var rect = el.getBoundingClientRect();

      if (!isVisible(el, rect)) continue;

      var descriptor = {
        id: 'el_' + index,
        tag: el.tagName,
        type: el.type || null,
        role: el.getAttribute('aria-role') || el.getAttribute('role') || inferRole(el),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        inViewport: isInViewport(rect),
        label: getElementLabel(el),
        placeholder: el.placeholder || null,
        value: el.value !== undefined ? el.value : null,
        checked: el.checked !== undefined ? el.checked : null,
        href: el.href || null,
        text: el.innerText ? el.innerText.trim().substring(0, 120) : null,
        enabled: !el.disabled,
      };

      results.push(descriptor);
      index++;
    }

    return results;
  }

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

  function getPageState() {
    return {
      url: location.href,
      title: document.title,
      elements: extractInteractiveElements(),
      context: getBrowserContext(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
    };
  }

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
  });

})();
