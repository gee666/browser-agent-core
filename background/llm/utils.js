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
 * Walk the string from the first `{` and return the substring that forms
 * the first syntactically-balanced JSON object, handling strings and escapes.
 * Returns null if no complete object is found.
 * @param {string} text
 * @returns {string|null}
 */
export function extractBalancedJson(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape)          { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true;  continue; }
      if (ch === '"')      { inString = !inString; continue; }
      if (inString)        { continue; }
      if (ch === '{')      { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
  }
  return null;
}

/**
 * Tries to parse a JSON object from free-form LLM output using four strategies:
 * 1. Direct JSON.parse of trimmed text
 * 2. Strip markdown code fences and try again
 * 3. Brace-balanced extraction (finds the first complete {...} object,
 *    correctly skipping strings and escape sequences)
 * 4. Naïve first-`{`-to-last-`}` slice (fallback)
 * @param {string} text
 * @returns {object} Parsed JSON object
 * @throws {LLMParseError}
 */
export function parseJSONFromText(text) {
  const t = text.trim();

  // Attempt 1: direct parse
  try { return JSON.parse(t); } catch (_) {}

  // Attempt 2: strip markdown code fences
  const fenceContent = extractJsonBlock(t);
  if (fenceContent !== null) {
    try { return JSON.parse(fenceContent.trim()); } catch (_) {}
  }

  // Attempt 3: brace-balanced extraction
  const balanced = extractBalancedJson(t);
  if (balanced !== null) {
    try { return JSON.parse(balanced); } catch (_) {}
  }

  // Attempt 4: naïve first-`{` to last-`}` (handles edge cases attempt 3 misses)
  const start = t.indexOf('{');
  const end   = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
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
