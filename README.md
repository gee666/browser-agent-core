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

## License

MIT
