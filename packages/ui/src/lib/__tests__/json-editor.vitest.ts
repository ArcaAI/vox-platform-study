import { describe, expect, it } from 'vitest';
import { formatJson, tokenizeJson, validateJson } from '../json-editor';

describe('validateJson', () => {
  it('accepts well-formed JSON', () => {
    expect(validateJson('{"a":1}')).toEqual({ ok: true });
    expect(validateJson('[1, 2, 3]')).toEqual({ ok: true });
    expect(validateJson('"just a string"')).toEqual({ ok: true });
  });

  it('reports a parse error with a 1-based line and column', () => {
    const result = validateJson('{\n  "a": 1,\n  "b":\n}');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error');
    expect(result.message).toBeTruthy();
    // The offending `}` sits on line 4.
    expect(result.line).toBe(4);
    expect(typeof result.column).toBe('number');
  });

  it('treats an empty string as invalid', () => {
    expect(validateJson('').ok).toBe(false);
    expect(validateJson('   ').ok).toBe(false);
  });
});

describe('formatJson', () => {
  it('pretty-prints with two-space indentation', () => {
    expect(formatJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('throws on invalid JSON', () => {
    expect(() => formatJson('{ nope }')).toThrow();
  });
});

describe('tokenizeJson', () => {
  it('classifies keys, strings, numbers, booleans, null and punctuation', () => {
    const tokens = tokenizeJson('{"k": "v", "n": 12, "b": true, "z": null}');
    const byType = (type: string) => tokens.filter((t) => t.type === type).map((t) => t.value);

    expect(byType('key')).toEqual(['"k"', '"n"', '"b"', '"z"']);
    expect(byType('string')).toEqual(['"v"']);
    expect(byType('number')).toEqual(['12']);
    expect(byType('boolean')).toEqual(['true']);
    expect(byType('null')).toEqual(['null']);
    expect(byType('punctuation').join('')).toContain('{');
  });

  it('round-trips: concatenating token values reproduces the source verbatim', () => {
    const source = '{\n  "a": [1, true, null],\n  "b": "x"\n}';
    expect(tokenizeJson(source).map((t) => t.value).join('')).toBe(source);
  });
});
