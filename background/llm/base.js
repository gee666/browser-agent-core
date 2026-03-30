/**
 * Abstract base class. Subclasses implement complete().
 */
export class LLMProvider {
  /**
   * @param {object} options
   * @param {string} options.system - System prompt
   * @param {Array<{role:string,content:string}>} options.messages - Conversation history
   * @param {string|null} options.screenshot - Base64 PNG data URL or null
   * @returns {Promise<string>} Raw LLM response text
   */
  async complete({ system, messages, screenshot }) {
    throw new Error('LLMProvider.complete() must be implemented by subclass');
  }
}
