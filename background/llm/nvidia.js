import { LLMProvider } from './base.js';
import { LLMError, buildImageContent } from './utils.js';

const VISION_MODEL_PATTERN = /vision|vl/i;

export class NvidiaProvider extends LLMProvider {
  constructor({
    apiKey,
    model = 'meta/llama-3.1-70b-instruct',
    baseUrl = 'https://integrate.api.nvidia.com/v1',
    maxTokens = 4096,
    temperature = 0.2,
  } = {}) {
    super();
    if (!apiKey) throw new Error('NvidiaProvider: apiKey is required');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
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
      throw new LLMError(`Nvidia API error: ${response.status}`, response.status, body);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
