import { LLMProvider } from './base.js';
import { LLMError, buildImageContent } from './utils.js';

const VISION_MODEL_PATTERN = /vision|gpt-4o|claude|llava|gemini/i;

export class OpenRouterProvider extends LLMProvider {
  constructor({
    apiKey,
    model = 'openai/gpt-4o',
    maxTokens = 4096,
    temperature = 0.2,
  } = {}) {
    super();
    if (!apiKey) throw new Error('OpenRouterProvider: apiKey is required');
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    const builtMessages = [
      { role: 'system', content: system },
      ...messages,
    ];

    const supportsVision = VISION_MODEL_PATTERN.test(this.model);
    if (screenshot && supportsVision && builtMessages.length > 0) {
      const last = builtMessages[builtMessages.length - 1];
      if (last.role === 'user') {
        builtMessages[builtMessages.length - 1] = {
          ...last,
          content: [
            { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
            buildImageContent(screenshot),
          ],
        };
      }
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'browser-agent-core',
        'X-Title': 'Browser Agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: builtMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LLMError(`OpenRouter API error: ${response.status}`, response.status, body);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
