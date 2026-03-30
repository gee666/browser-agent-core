import { LLMProvider } from './base.js';
import { LLMError, buildImageContent } from './utils.js';

export class OllamaProvider extends LLMProvider {
  constructor({
    baseUrl = 'http://localhost:11434',
    model = 'llava',
    temperature = 0.2,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = temperature;
  }

  async complete({ system, messages, screenshot }) {
    const builtMessages = [
      { role: 'system', content: system },
      ...messages,
    ];

    if (screenshot && builtMessages.length > 0) {
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

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: builtMessages,
        temperature: this.temperature,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LLMError(`Ollama API error: ${response.status}`, response.status, body);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
