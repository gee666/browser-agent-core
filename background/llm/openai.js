import { LLMProvider } from './base.js';

/** Returns true for OpenAI models that support response_format:json_object. */
function _supportsJsonMode(model) {
  // Exclude o1/o3/o4 reasoning models — they don't accept response_format.
  if (/^o\d/i.test(model)) return false;
  return true;
}
import { LLMError, buildImageContent } from './utils.js';

export class OpenAIProvider extends LLMProvider {
  constructor({
    apiKey,
    model = 'gpt-4o',
    baseUrl = 'https://api.openai.com/v1',
    maxTokens = 4096,
    temperature = 0.2,
  } = {}) {
    super();
    if (!apiKey) throw new Error('OpenAIProvider: apiKey is required');
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

    const supportsVision = /gpt-4o?|vision/.test(this.model);
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
        ...(_supportsJsonMode(this.model) ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LLMError(`OpenAI API error: ${response.status}`, response.status, body);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
