import { parseJSONFromText, LLMParseError } from '../../background/llm/utils.js';

describe('parseJSONFromText', () => {
  test('test_parse_plain_json', () => {
    const result = parseJSONFromText('{"done":true}');
    expect(result).toEqual({ done: true });
  });

  test('test_parse_json_code_fence', () => {
    const result = parseJSONFromText('```json\n{"done":true}\n```');
    expect(result).toEqual({ done: true });
  });

  test('test_parse_json_plain_fence', () => {
    const result = parseJSONFromText('```\n{"done":true}\n```');
    expect(result).toEqual({ done: true });
  });

  test('test_parse_json_with_leading_text', () => {
    const result = parseJSONFromText('Here is the response:\n{"done":true}');
    expect(result).toEqual({ done: true });
  });

  test('test_throws_on_invalid_json', () => {
    expect(() => parseJSONFromText('not json at all')).toThrow(LLMParseError);
  });

  test('test_throws_on_empty_string', () => {
    expect(() => parseJSONFromText('')).toThrow(LLMParseError);
  });
});
