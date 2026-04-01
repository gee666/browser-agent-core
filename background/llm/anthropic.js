import { LLMProvider } from './base.js';
import { LLMError } from './utils.js';

export class AnthropicProvider extends LLMProvider {
  constructor({
    apiKey,
    model = 'claude-opus-4-5',
    maxTokens = 4096,
    temperature = 0.2,
  } = {}) {
    super();
    if (!apiKey) throw new Error('AnthropicProvider: apiKey is required');
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    // Convert messages to Anthropic format; system is a top-level field
    const anthropicMessages = messages.map((msg, index) => {
      const isLast = index === messages.length - 1;
      if (isLast && msg.role === 'user' && screenshot) {
        // Strip data URL prefix to get raw base64
        const _mimeMatch = screenshot.match(/^data:(image\/[^;]+);base64,/);
        const _mediaType = _mimeMatch ? _mimeMatch[1] : 'image/png';
        const base64Data = screenshot.replace(/^data:image\/[^;]+;base64,/, '');
        return {
          role: msg.role,
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: _mediaType,
                data: base64Data,
              },
            },
            { type: 'text', text: typeof msg.content === 'string' ? msg.content : '' },
          ],
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        system,
        messages: [...anthropicMessages, { role: 'assistant', content: '{' }],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LLMError(`Anthropic API error: ${response.status}`, response.status, body);
    }

    const data = await response.json();
    return '{' + data.content[0].text;
  }
}
