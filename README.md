# browser-agent-core

A reusable Chrome extension framework for LLM-driven browser automation. It provides the core agent loop, action execution pipeline, and LLM provider adapters needed to build a browser-controlling AI agent as a Chrome extension.

## Overview

`browser-agent-core` is designed to be embedded in a Chrome extension. It orchestrates:

1. **Page state extraction** — reading interactive elements, scroll position, and viewport dimensions from the live DOM.
2. **LLM reasoning** — sending page state (and optionally a screenshot) to a language model and parsing its JSON response.
3. **Action execution** — translating LLM-chosen actions into real input events via the `python-input-control` native messaging host.

## Exports

### `browser-agent-core/background`

Everything needed in the extension service worker / background script:

| Export | Description |
|---|---|
| `AgentCore` | Main agent loop — drives reasoning, acting, and status reporting |
| `BrowserBridge` | Abstracts Chrome extension APIs (tabs, screenshots, page state) |
| `ActionExecutor` | Sequences actions, auto-scrolls off-screen elements, auto-moves mouse before clicks |
| `InputControlBridge` | Native messaging adapter for `python-input-control` |
| `OpenAIProvider` | LLM provider for OpenAI-compatible APIs |
| `AnthropicProvider` | LLM provider for Anthropic Claude |
| `OllamaProvider` | LLM provider for local Ollama models |
| `OpenRouterProvider` | LLM provider for OpenRouter |
| `NvidiaProvider` | LLM provider for NVIDIA NIM endpoints |

### `browser-agent-core/content`

| Export | Description |
|---|---|
| `extractor` (default export) | Content-script DOM extractor — collects interactive elements and page metadata |

## Supported LLM Providers

- **OpenAI** — GPT-4o, GPT-4-turbo, and any OpenAI-compatible endpoint
- **Anthropic** — Claude 3 and later models with vision support
- **Ollama** — Local open-weight models (llama3, mistral, etc.)
- **OpenRouter** — Unified gateway to dozens of hosted models
- **NVIDIA NIM** — NVIDIA-hosted inference endpoints

## Requirements

- Chrome / Chromium with Manifest V3 extension support
- [`python-input-control`](https://github.com/your-org/python-input-control) installed and registered as a native messaging host — this is the bridge that translates action commands into real OS-level mouse/keyboard events

## Usage

```javascript
import { AgentCore, BrowserBridge, ActionExecutor, InputControlBridge, OpenAIProvider }
  from 'browser-agent-core/background';

const bridge       = new BrowserBridge();
const inputControl = new InputControlBridge();
const executor     = new ActionExecutor({ bridge, inputControl });
const llm          = new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' });

const agent = new AgentCore({
  llm,
  bridge,
  executor,
  onStatus: (status) => console.log(status),
});

const result = await agent.run('Go to https://example.com and click the login button');
console.log(result);
```

## Native input contract

`ActionExecutor` sends mouse movement, clicks, typing, shortcuts, keys and scrolling exclusively through `inputControl.execute`. Native clicking focuses editable targets. Existing movement, typing and settling delays are retained, including the 80ms focus-settling pause. Off-screen targets use native wheel scrolling with the existing viewport-relative coordinate calculation on both axes, up to three scroll/refetch attempts. Horizontal off-screen targets add a native horizontal wheel delta; wheel origin, duration, click coordinates and settling delays are unchanged.

The executor never calls `bridge.focusElement`, `bridge.scrollElementIntoView` or `bridge.scrollToPosition`, even if an embedder supplies them. Native input failures propagate without a DOM-input fallback. DOM-only focus cannot rescue an incorrectly chosen wrapper; target its actual editable control instead.

## Staged Jev decisions

Normal mode remains the default. `BrowserAgent` is an alias of `AgentCore` exported from `background/index.js`. Both constructors accept these optional arguments:

```javascript
const agent = new AgentCore({
  bridge, executor, llm,
  decisionMode: 'jev', // 'llm' by default
  decisionConfig: {
    baseUrl: 'http://localhost:8765',
    apiKey: jevKeyFromStorage,
    model: 'jev-latest',
    headers: {},
    requestParams: {},
    timeoutMs: 1200000,
    fallbackEnabled: true,
  },
  helperLlm: llm, // defaults to llm; may use a different configured model
  onDiscovery: diagnostic => saveRedactedDiagnostic(diagnostic),
});
```

The core does not read settings or credentials from storage. Embedders supply configuration. `baseUrl` accepts an origin, a `/v1` URL, or a full `/v1/systemone` endpoint. Headers must have valid names and string values without control characters. Authentication and transport headers are reserved. Request parameters cannot replace `model`, `state`, `questions`, or `images`. The default timeout is 1200000ms, following AutoJev's minimum 1200-second loading/queue guidance. Explicit timeouts must be integer milliseconds from 1 to 3600000; shorter values are accepted for controlled tests but are not recommended for local model requests.

Each step starts with one action question and five independent speculative target questions. Private decision context retains the last 20 user steers and up to three observed DOM snapshots, capped at 6000 characters each, so corrections and observed values can survive navigation. Both reset between runs. `SCREENSHOT_NEEDED` requests one screenshot stage. That stage removes the screenshot choice and permits `TARGET_NOT_LISTED` for indexed actions. Up to 253 current targets are offered, preferring on-screen elements. Jev failures and invalid choices use at most two normal LLM classification attempts with the same state, choices and image. `BLOCKED` is a valid decision, not a provider failure. The selected action/target and helper parameters are validated locally; unrelated target heads are ignored.

A helper supplies typing text, dropdown labels, navigation URLs and factual final messages. Helpers cannot change the chosen action or index. Typing/dropdown schemas permit `{text: null}` when the required value is unspecified, unavailable or ambiguous. Null, missing text, or an explicit `missing: true` signal immediately produce a failed/blocked completion without retrying the helper or issuing input. An explicit empty string remains a valid clearing action. `DONE` does not force a success claim near the iteration limit. Every staged terminal status explicitly carries `success` and `blocked`: failed, incomplete or missing-input completions use `success: false, blocked: true`; successful completions use `success: true, blocked: false`. Existing `verifyDone` remains available; failed/blocked completions do not require verification. Staged provider/helper calls pass cancellation signals and race the configured timeout. Executor input timing is unchanged.

### Choice contract

Both stages offer `action`, `target_CLICK`, `target_TYPE`, `target_SELECT_OPTION`, `target_SCROLL_ELEMENT_UP`, and `target_SCROLL_ELEMENT_DOWN`. Each target question assumes its named operation, independently of the action answer, and offers the same current elements. Descriptors appear once in `state.currentTargets`; criteria contain only concise `[index]` references to that table. No semantic-role or native-tag filter narrows the existing reader. Up to 253 `E_<index>` choices are offered per head, plus `NO_TARGET` in text mode or `TARGET_NOT_LISTED` in screenshot mode.

Jev returns `answers[id].choice`. The normal LLM fallback receives the identical questions, state and screenshot, and a JSON schema mapping those same question IDs to string choice IDs. For example, `{action: 'CLICK', target_CLICK: 'E_5', target_TYPE: 'NO_TARGET', ...}`. Internally both normalize to `{action, target}` by consuming only the chosen operation's head. Non-indexed actions use `target: 'NONE'` and do not consume any target head. A selected text `NO_TARGET` normalizes to `SCREENSHOT_NEEDED`; a selected screenshot `TARGET_NOT_LISTED` triggers investigation. Missing/invalid selected answers cause fallback or bounded failure; missing/invalid unused answers do not override a valid selected operation. The raw fallback contract remains those same question IDs, including on large pages.

AutoJev's documented context is 12,288 tokens. A conservative preflight routes requests above 24,576 serialized UTF-8 bytes to the normal LLM, reserving another 4096 bytes when a screenshot is present. This is not a tokenizer: a smaller request may still exceed the server's context limit and use the same fallback on rejection. Current DOM and offered target descriptors are not silently truncated to fit Jev. `targetCoverage` reports listed/total/omitted counts; targets beyond the choice cap remain unavailable choices, requiring escalation/investigation rather than invented indices. Bounded prior observations explicitly mark truncated records.

OpenAI strict schemas count repeated enum values across the entire schema. At 197 or 253 targets the five target heads exceed 1000 enum entries, so the OpenAI adapter uses `response_format: {type: 'json_object'}` and the OAuth Responses adapter uses `text.format: {type: 'json_object'}`. Local selected-head and parameter validation is unchanged. Responses JSON mode is documented in the [OpenAI structured outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs); live Codex backend compatibility remains an embedding integration check.

Each classification emits `_status` telemetry in `decision: {stage, provider, action, target, durationMs}`. Stages are `text` or `screenshot`; providers are `jev` or `llm-fallback`. Unsuccessful provider classifications use null action/target. Elapsed milliseconds include prior attempts within that stage. No goals, URLs, target descriptors, screenshots, credentials, provider bodies or errors enter this telemetry. Both status callbacks retain the extra `decision` object. Jev screenshot escalation intentionally operates independently of normal mode's `useVision` flag.

### Connection probe

```javascript
import { testJevConnection } from 'browser-agent-core/background';
const result = await testJevConnection(decisionConfig, { signal }); // { ok: true }
```

The probe sends a single `READY` choice question to the same endpoint. It rejects on HTTP errors, invalid answers, timeout or cancellation. Errors never include server bodies or credential values. Images are top-level data URIs, limited to four. Each decoded image is independently limited to 8,000,000 bytes and 16 megapixels; neither limit is aggregated across the array. Known PNG/JPEG/WebP dimensions are checked before sending; the API validates actual image files.

### Read-only target investigation

`BrowserBridge` adds `inspectDOM(tabId, {selector, limit})` and `resolveDOMTarget(tabId, {selector, expectedUrl})`. The content messages are `inspect_dom` and `resolve_dom_target`. Inspection returns descriptive element records and structural CSS locators, not executable JavaScript or raw HTML. It scans at most 2000 nodes and returns at most 40 records per query. The agent makes at most three queries with at most two helper attempts per query.

Resolution requires exactly one visible, enabled, on-screen element on the expected URL. The extractor registers at most 20 discovered targets per document, preserving them during ordinary re-extraction/native scrolling while connected and eligible. Resolution returns `{ok, index, locator, domContext, pageState}`. `domContext` describes the target, up to six nearest ancestors and eight direct children using structural tags, counts, locators and structural attributes so the existing executor uses the same index, rectangle and browser-context contract. No input is performed by investigation.

`onDiscovery` receives the following persistence-safe event contract:

- `discoveryId`: session ID plus iteration, shared by all events for the miss. The runtime can use it to persist a report and expose a log link later; the core does not create a log URL.
- `url`: HTTP(S) origin plus sanitized pathname. Userinfo, query and hash are stripped; known credential/field/query values, sensitive reset/invitation paths and recognizable opaque token segments are redacted.
- `operation`, `originalListedIndices`, `originalListedCount`, `originalElementCount`: the selected indexed operation and its original snapshot/choice counts, before investigation changes the index map.
- `context`: numeric viewport and scroll metadata. `reason`: a fixed explanation, never a model explanation or raw error. `executionResult`: investigation/resolution/execution outcome. `timestamp`: milliseconds since epoch.
- `screenshotCaptured`, `screenshotSaved: false`, `screenshotPrivacy`: capture availability plus an explicit notice that screenshots were not persisted because reliable pixel redaction is unavailable.
- Optional `inspectedDOM`: up to eight sanitized structural records from the last inspection, also available on an unresolved miss.
- Resolved events add `locator` and `relevantDOM`. The latter contains sanitized `tag`, `index`, numeric `rect`, structural `target`, nearest-first `ancestors`, direct `children`, and a generated `excerpt`. Records retain only allowlisted structural enums, attribute-name presence and child counts. The excerpt is generated markup, not copied HTML. IDs, classes, labels, field values, text, event handlers and arbitrary attributes are not copied.

It never receives screenshots, tasks, user text, free-form model explanations or provider payloads. Async callback failures do not block execution. Staged turns bypass the raw debug logger; status tasks and planned typing/dropdown text are omitted. Status URL metadata and planned navigation URLs use origin only. Final answer messages remain visible to the user.

### Limits

Investigation currently covers the current document's light DOM only, not iframe or shadow-root targets. It does not execute arbitrary JavaScript. Off-screen missing targets require an ordinary scroll step before registration. The target choice cap may require screenshot escalation/investigation on large pages. Canvas-only controls without a real DOM target cannot be registered. Prior-page evidence retention is bounded DOM text, not a full page archive or screenshot memory. Sensitive path segments may become `[redacted]`, so the diagnostic page URL may not be directly navigable; the runtime's report link is separate. Path redaction uses known values and token/route patterns, not application-specific knowledge.

Screenshots and page/task context are sent to the configured decision/helper providers, but screenshots are deliberately not persisted in discovery diagnostics because reliable pixel redaction is unavailable. Use a vision-capable fallback/helper for visual tasks. OpenAI's supported official models and OpenAI OAuth accept the optional `complete({responseSchema})` argument for strict structured output; other providers retain their existing JSON behavior and rely on local validation. Live endpoint/provider compatibility must be checked by the embedding extension.

## License

MIT
