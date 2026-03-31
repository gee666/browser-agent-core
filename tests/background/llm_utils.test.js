import { parseJSONFromText, LLMParseError, extractBalancedJson } from '../../background/llm/utils.js';

describe('parseJSONFromText', () => {
  test('test_parse_plain_json', () => {
    expect(parseJSONFromText('{"done":true}')).toEqual({ done: true });
  });

  test('test_parse_json_code_fence', () => {
    expect(parseJSONFromText('```json\n{"done":true}\n```')).toEqual({ done: true });
  });

  test('test_parse_json_plain_fence', () => {
    expect(parseJSONFromText('```\n{"done":true}\n```')).toEqual({ done: true });
  });

  test('test_parse_json_with_leading_text', () => {
    expect(parseJSONFromText('Here is the response:\n{"done":true}')).toEqual({ done: true });
  });

  test('test_parse_json_with_trailing_text', () => {
    // trailing text with } should not break extraction
    expect(parseJSONFromText('{"done":true}\n\nNote: that was the JSON}')).toEqual({ done: true });
  });

  test('test_parse_json_with_nested_objects', () => {
    const input = '{"action":{"click":{"index":3}}}';
    expect(parseJSONFromText(input)).toEqual({ action: { click: { index: 3 } } });
  });

  test('test_parse_json_with_string_containing_braces', () => {
    const input = '{"memory":"went to page {home}","next_goal":"click"}';
    expect(parseJSONFromText(input)).toEqual({ memory: 'went to page {home}', next_goal: 'click' });
  });

  test('test_parse_leading_and_trailing_prose', () => {
    const input = 'Sure! Here you go:\n```json\n{"action":{"done":{"success":true,"message":"ok"}}}\n```\nLet me know if you need anything else.';
    const result = parseJSONFromText(input);
    expect(result.action.done.success).toBe(true);
  });

  test('test_throws_on_invalid_json', () => {
    expect(() => parseJSONFromText('not json at all')).toThrow(LLMParseError);
  });

  test('test_throws_on_empty_string', () => {
    expect(() => parseJSONFromText('')).toThrow(LLMParseError);
  });
});

describe('extractBalancedJson', () => {
  test('test_simple_object', () => {
    expect(extractBalancedJson('{"a":1}')).toBe('{"a":1}');
  });

  test('test_object_with_trailing_text', () => {
    expect(extractBalancedJson('{"a":1} extra } text')).toBe('{"a":1}');
  });

  test('test_object_with_leading_text', () => {
    expect(extractBalancedJson('prefix {"a":1}')).toBe('{"a":1}');
  });

  test('test_nested_objects', () => {
    const input = '{"a":{"b":{"c":3}}}';
    expect(extractBalancedJson(input)).toBe(input);
  });

  test('test_string_with_braces_not_confused', () => {
    const input = '{"key":"val}ue"}';
    expect(extractBalancedJson(input)).toBe(input);
  });

  test('test_string_with_escaped_quote', () => {
    const input = '{"key":"val\\"ue"}';
    expect(extractBalancedJson(input)).toBe(input);
  });

  test('test_returns_null_for_no_object', () => {
    expect(extractBalancedJson('no braces here')).toBeNull();
  });

  test('test_returns_null_for_unclosed_object', () => {
    expect(extractBalancedJson('{"a":1')).toBeNull();
  });
});
