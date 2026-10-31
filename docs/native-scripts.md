# External JavaScript through native input

`NativeScriptService` accepts external JavaScript source but never executes it. The configured AI provider translates every request, including read-only expressions, into a bounded JSON plan. Core validates the whole plan before inspecting the page or sending input. A fixed interpreter runs the plan.

This is a supported-subset translator, not a JavaScript runtime or sandbox. It rejects scripts the protocol cannot represent. There is no raw-execution fallback. AI translation can still misunderstand source. Validation limits what the plan can do; it does not prove that the plan is equivalent to the original JavaScript.

## Integration contract

```js
import { NativeScriptService, InputControlBridge }
  from './lib/browser-agent-core/background/index.js';

const scripts = new NativeScriptService({
  llm: configuredProvider,
  inputControl: new InputControlBridge(),
});

const result = await scripts.executeExternalScript({
  tabId: 123,
  kind: 'expression',
  source: 'document.title',
  args: [],
  awaitPromise: true,
  returnByValue: true,
  captureConsole: false,
  timeoutMs: 120000,
  signal: abortController.signal,
});
// { value: 'Example', type: 'string', subtype: undefined }
```

Only `llm` is required in the constructor. `inputControl` defaults to a new Python `InputControlBridge`. A supplied bridge must implement `execute(command, params, context)`, `abort()` and `disconnect()`. Core validates these methods, not the bridge's class. The embedding runtime should inject the same configured Python or CDP bridge used by its action executor. The sibling [`browser-agent-input-control`](../../browser-agent-input-control/README.md) package supplies `CdpInputControlBridge`, which needs no native messaging host. Input backends are trusted constructor dependencies, never external request fields. Requests cannot select a backend or override the configured bridge.

Core calls the existing provider's `complete({ system, messages, signal })`; it does not load credentials, choose models, or create a second AI configuration. Jev integrations should inject their configured helper LLM, not the choice-decision endpoint. Translation does not depend on whether the agent uses normal or Jev decisions.

The default `NativeScriptPageBridge` uses `chrome.scripting.executeScript` with one fixed read-only function in the `ISOLATED` world. It supplies geometry, native screen context and supported reads. No extractor, indexed page state or `BrowserBridge` is required. An optional constructor `page` adapter is for trusted embedders and tests only. Its methods are `snapshot(tabId)`, `target(tabId, selector)`, `read(tabId, readStep)` and `assertActive(tabId)`. Do not expose that dependency to external requests.

Route every externally supplied evaluate/run-JS source through `executeExternalScript`. Trusted built-in inspection can keep its existing implementation. Runtime adapters may accept `world: 'main'` for compatibility with tool schemas, but must strip that option before calling core and explain that it does not grant page-world execution. No original or model-generated JavaScript reaches Chrome scripting. Unsupported options must reject instead of bypassing translation.

### Request and response

- `tabId`, `kind` and `source` are required. `kind` is `expression` or `program`. Expression requests return the expression value. Program requests describe a function body with `args` available, or a function invoked with spread arguments. Unrepresentable or ambiguous semantics must reject.
- `args` defaults to `[]` and accepts acyclic JSON only. Functions, accessors, custom prototypes, sparse arrays, undefined, nonfinite numbers and prototype-related keys reject. Arguments are copied before translation.
- `awaitPromise` and `returnByValue` default to `true`. `false` rejects. Detached execution and remote object handles are not supported.
- `captureConsole` defaults to `false`. When true, validated log steps produce `console_entries: [{ level, args }]`. These are interpreted console values, not a capture of arbitrary page console traffic.
- `timeoutMs` defaults to 120000 and accepts integers from 1 to 300000. `signal` is optional.
- The result is `{ value, type, subtype }`. `type` uses JavaScript `typeof`. `subtype` is `null` for null, `array` for arrays, otherwise undefined. Undefined results retain `value: undefined`; serialization remains the runtime's responsibility. Other values must pass bounded JSON validation.
- `execute(request)` aliases `executeExternalScript(request)` and returns the same normalized object, not the raw value.

Keep one service per runtime/provider configuration. A module-wide busy lock rejects overlapping native script requests, including time spent translating. It releases in `finally`. The runtime must also serialize unrelated desktop input against these requests. Native input requires the requested tab to be active and its Chrome window focused. Core does not activate tabs or windows silently. Read-only requests do not require focus.

## Supported operations

The protocol supports:

- Unique CSS target clicks with left, right or middle button and single/double click; hover; native-click focus.
- Text replacement and appending in editable inputs, textareas and contenteditable controls. Replacement uses select-all/delete. Appending explicitly moves the caret to the end through native End or the multiline shortcut. It is not insertion at the current caret. Scripts requiring current-caret insertion or exact synthetic-event semantics must reject.
- Keys, repeated keys and shortcuts, optionally focused on a selector first.
- Relative viewport/container wheel scrolling, native scroll-to-target, and absolute viewport `scrollTo` with numeric or typed-expression coordinates. Absolute targets clamp to current document bounds, use live offsets and fail if bounded wheel attempts cannot reach the target. Smooth-scroll timing is not supported.
- Bounded waits through native `pause` and captured console log steps.
- `document.title`, `location.href`, scroll offsets, viewport dimensions and page scroll dimensions.
- Selector `textContent`, `innerText`, `innerHTML`, `outerHTML`, form `value`, `checked`, `disabled`, `tagName`, named attribute and rectangle reads. Rectangle data is `{ x, y, width, height }`. Single reads require exactly one match. Same-property arrays use `all: true`; `count` and `exists` allow any number of matches.
- Typed literal, argument, earlier-read reference, array and object return expressions. JSON own-field reads and numeric `+`, `-`, `*`, `/`, `%`, comparisons and primitive strict equality are supported. String `+` concatenates two strings. There is no implicit coercion or arbitrary getter lookup.

For example, `document.querySelector('#price').textContent`, `document.querySelector('#name').value`, `document.querySelector('#card').getBoundingClientRect().width * 2`, and arrays of a single selected property have protocol representations. Transforming a live read with arbitrary JavaScript such as `.trim()`, custom map callbacks, loops or conditional branches does not.

The shared input protocol's action commands are `mouse_move`, `mouse_click`, `scroll`, `type`, `press_key`, `press_shortcut`, `pause` and `sequence`. Plans cover those action families; the interpreter performs sequences one command at a time so it can check cancellation before each action. There is no arbitrary command passthrough. Drag, held mouse down/up and screenshots are not commands in that shared interface and are not invented here. Screenshot tools should retain their trusted built-in implementation.

Other unsupported source includes network requests, navigation, storage, arbitrary DOM writes, event listener registration, custom page functions, eval, DOM-node returns, object handles and computations outside the typed expression grammar. Checkbox property assignment is not silently treated as text input. Scripts whose event ordering or property mutation cannot be preserved must reject.

## Input and failure rules

All interaction goes through `this._inputControl.execute(command, params, context)`. No DOM clicks, focus calls, synthetic events, input-value writes or DOM scrolling are available to the interpreter. Fixed page inspection uses explicit property switches rather than arbitrary property access.

Targets must match exactly one enabled, visible element. Inspection intersects viewport and ancestor clipping bounds, hit-tests the target point, and finds visible native wheel recipients for nested scroll containers. Offscreen targets get at most eight bounded native scroll attempts and are re-resolved after scrolling. Targets are re-resolved and hit-tested again between pointer movement and clicking, because hover can change layout. A hidden, ambiguous, obscured or unreachable target fails.

Every native command refreshes screen context, checks the active target tab and focused browser window, and checks cancellation before sending input. A URL change during target resolution fails. Wheel deltas for auto-scroll and absolute scrolling are bounded to 1000 pixels per command. Abort and timeout cancel the provider signal, stop further plan steps and call `abort()` on active input. Core handles synchronous and promise-returning abort methods. Abort failures do not replace the cancellation error or cause unhandled promise rejections. The embedding runtime owns cleanup and must await `disconnect()` before releasing its shared input lock, since CDP detach is asynchronous. Partial actions already performed are not rolled back. Input failures propagate without retries or alternative backends.

Model output must be exactly one JSON object, not markdown or embedded code. Validation rejects unknown operations/fields, forward references, invalid bounds, unsafe JSON keys and excessive depth/size before page/native work. Default limits are 64 KiB source, 64 KiB arguments, 128 KiB model response, 100 steps, 1000 property-array matches, 1 MiB results, 20 JSON nesting levels and 10000 JSON nodes. Limits use JavaScript string length, not UTF-8 byte length.

`NativeScriptError` has a stable `code` and, for validated step failures, optional `stepIndex`. Codes include `E_SCRIPT_CONFIG`, `E_SCRIPT_REQUEST`, `E_SCRIPT_UNSUPPORTED`, `E_SCRIPT_PLAN`, `E_SCRIPT_PAGE`, `E_SCRIPT_TARGET`, `E_SCRIPT_TAB`, `E_SCRIPT_BUSY`, `E_SCRIPT_ABORTED`, `E_SCRIPT_TIMEOUT` and `E_SCRIPT_EXECUTION`. Provider/native/Chrome failures are wrapped with the original error as `cause`. Public messages omit source and model output. Do not log causes without checking their contents.

## Tests

```sh
npm test -- --runInBand tests/background/native-script.test.js tests/background/native-script-page.test.js
```

Tests cover input-interface validation, rejection of request backend injection, translated click/key execution through a duck-typed adapter with no native host, whole-plan validation, common reads/results, native command ordering, caret positioning, hover geometry refresh, offscreen and nested clipping, hit-testing, absolute scroll clamping, inactive tabs/windows, provider/input failures, cancellation during translation/input, abort failures, timeouts and the global lock.
