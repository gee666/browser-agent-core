export class LLMParseError extends Error {
  constructor(message, rawText) {
    super(message);
    this.name = 'LLMParseError';
    this.rawText = rawText;
  }
}

export class LLMError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Tries to parse JSON from text using three strategies:
 * 1. Direct JSON.parse of trimmed text
 * 2. Strip markdown code fences and try again
 * 3. Extract substring from first `{` to last `}`
 * @param {string} text
 * @returns {object} Parsed JSON object
 * @throws {LLMParseError}
 */
export function parseJSONFromText(text) {
  // Attempt 1: direct parse
  try {
    return JSON.parse(text.trim());
  } catch (_) {}

  // Attempt 2: strip markdown code fences
  const fenceMatch = extractJsonBlock(text);
  if (fenceMatch !== null) {
    try {
      return JSON.parse(fenceMatch.trim());
    } catch (_) {}
  }

  // Attempt 3: first `{` to last `}`
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {}
  }

  throw new LLMParseError('Failed to parse JSON from LLM response', text);
}

/**
 * Extracts content from a markdown code fence block.
 * @param {string} text
 * @returns {string|null}
 */
export function extractJsonBlock(text) {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return match ? match[1] : null;
}

/**
 * Builds an OpenAI-style image content part.
 * @param {string} screenshotDataUrl - Base64 PNG data URL
 * @returns {{ type: string, image_url: { url: string } }}
 */
export function buildImageContent(screenshotDataUrl) {
  return {
    type: 'image_url',
    image_url: { url: screenshotDataUrl },
  };
}
