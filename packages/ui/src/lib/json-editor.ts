/**
 * JSON editor helpers for the `CodeEditor` component: parse/validate with
 * line-column error reporting, pretty-print, and a tiny synchronous tokenizer
 * that drives syntax highlighting without an async highlighter (Shiki) — the
 * editor surface is a fixed dark colour in both themes, so a theme-switching
 * highlighter is the wrong tool. The tokenizer is loss-less: concatenating the
 * emitted token values reproduces the source verbatim, which keeps the
 * highlighted overlay perfectly aligned with the underlying textarea.
 */

export type JsonValidation = { ok: true } | { ok: false; message: string; line?: number; column?: number };

/** 1-based line/column for a 0-based character offset into `source`. */
function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline };
}

class JsonScanError extends Error {
  constructor(readonly offset: number) {
    super('json scan error');
  }
}

/**
 * Locate the character offset of the first structural error in an invalid JSON
 * string. `JSON.parse` stays the authority on *whether* the input is valid; this
 * only runs when it is not, because V8's error messages don't reliably carry a
 * position across engine versions. A minimal recursive-descent scan mirrors the
 * grammar closely enough to point at the offending character.
 */
function locateJsonError(src: string): number {
  const n = src.length;
  let i = 0;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = () => {
    while (i < n && isWs(src[i]!)) i += 1;
  };
  const fail = (): never => {
    throw new JsonScanError(i);
  };
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

  function parseString(): void {
    i += 1; // opening quote
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return;
      }
      i += 1;
    }
    fail(); // unterminated string
  }

  function parseNumber(): void {
    const start = i;
    if (src[i] === '-') i += 1;
    while (isDigit(src[i])) i += 1;
    if (src[i] === '.') {
      i += 1;
      while (isDigit(src[i])) i += 1;
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i += 1;
      if (src[i] === '+' || src[i] === '-') i += 1;
      while (isDigit(src[i])) i += 1;
    }
    if (i === start) fail();
  }

  function parseObject(): void {
    i += 1; // '{'
    skipWs();
    if (src[i] === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skipWs();
      if (src[i] !== '"') fail();
      parseString();
      skipWs();
      if (src[i] !== ':') fail();
      i += 1;
      parseValue();
      skipWs();
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      if (src[i] === '}') {
        i += 1;
        return;
      }
      fail();
    }
  }

  function parseArray(): void {
    i += 1; // '['
    skipWs();
    if (src[i] === ']') {
      i += 1;
      return;
    }
    for (;;) {
      parseValue();
      skipWs();
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      if (src[i] === ']') {
        i += 1;
        return;
      }
      fail();
    }
  }

  function parseValue(): void {
    skipWs();
    if (i >= n) fail();
    const c = src[i]!;
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || isDigit(c)) return parseNumber();
    if (src.startsWith('true', i)) {
      i += 4;
      return;
    }
    if (src.startsWith('false', i)) {
      i += 5;
      return;
    }
    if (src.startsWith('null', i)) {
      i += 4;
      return;
    }
    fail();
  }

  try {
    parseValue();
    skipWs();
    return i < n ? i : n; // trailing garbage, or ran clean (e.g. "unexpected end")
  } catch (error) {
    return error instanceof JsonScanError ? error.offset : n;
  }
}

/**
 * Validate a JSON string. On failure, returns the parser message plus a 1-based
 * line/column: taken from the message when V8 embeds one, else located by a
 * grammar scan.
 */
export function validateJson(value: string): JsonValidation {
  try {
    JSON.parse(value);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol) {
      return { ok: false, message, line: Number(lineCol[1]), column: Number(lineCol[2]) };
    }
    const position = /position (\d+)/.exec(message)?.[1];
    const offset = position !== undefined ? Number(position) : locateJsonError(value);
    const { line, column } = lineColumnAt(value, offset);
    return { ok: false, message, line, column };
  }
}

/** Pretty-print a JSON string with two-space indentation. Throws if invalid. */
export function formatJson(value: string, indent = 2): string {
  return JSON.stringify(JSON.parse(value), null, indent);
}

export type JsonTokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation' | 'text';

export interface JsonToken {
  type: JsonTokenType;
  value: string;
}

// String | number | true/false | null | structural punctuation | whitespace | anything else.
const TOKEN_RE = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false)\b|(null)\b|([{}[\],:])|(\s+)|([^\s{}[\],:"]+)/g;

/**
 * Split a JSON-ish string into typed tokens for highlighting. A quoted string is
 * a `key` when the next non-whitespace character is a colon, otherwise a
 * `string`. Invalid input still tokenizes (best-effort) so the editor highlights
 * as the user types; validity is reported separately by {@link validateJson}.
 */
export function tokenizeJson(source: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;

  while ((match = TOKEN_RE.exec(source)) !== null) {
    // Preserve any characters the regex skipped so the output stays loss-less.
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: source.slice(lastIndex, match.index) });
    }
    const [, str, num, bool, nul, punct] = match;

    if (str !== undefined) {
      const isKey = /^\s*:/.test(source.slice(TOKEN_RE.lastIndex));
      tokens.push({ type: isKey ? 'key' : 'string', value: str });
    } else if (num !== undefined) {
      tokens.push({ type: 'number', value: num });
    } else if (bool !== undefined) {
      tokens.push({ type: 'boolean', value: bool });
    } else if (nul !== undefined) {
      tokens.push({ type: 'null', value: nul });
    } else if (punct !== undefined) {
      tokens.push({ type: 'punctuation', value: punct });
    } else {
      tokens.push({ type: 'text', value: match[0] });
    }

    lastIndex = TOKEN_RE.lastIndex;
  }

  if (lastIndex < source.length) {
    tokens.push({ type: 'text', value: source.slice(lastIndex) });
  }
  return tokens;
}
