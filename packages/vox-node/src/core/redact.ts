/**
 * PHI/secret redaction for logs and errors.
 *
 * HOPE handles protected health information (transcripts, summaries). This
 * module provides two structural (not conventional) guarantees used
 * throughout `core/**`:
 *
 *   1. {@link redactHeaders} — strip credential VALUES out of any headers
 *      object before it is ever stored on an error or handed to a logger.
 *   2. {@link redact} / {@link RedactedValue} — wrap a value (e.g. a raw
 *      response body) so its `toString()`/`toJSON()`/`util.inspect()` output
 *      is ALWAYS the literal string `"[REDACTED]"`, regardless of what code
 *      later touches that value. The only way to get the real value back is
 *      the explicitly-named `.reveal()` method — there is no accidental path
 *      to it through string coercion, JSON serialization, or Node's
 *      inspector (the mechanism `console.log`/most loggers use).
 */

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Header names (lowercase) whose VALUE is always replaced by
 * {@link redactHeaders} — one entry per credential class the platform can put
 * on the wire: `authorization` (user JWT), `x-api-key` (tenant API key),
 * `x-service-token` (internal peer-service secret), and
 * `x-service-account-token` (the machine credential — `core/service-account-token.ts`).
 * Adding a credential header without adding it here is how a secret reaches a
 * log line, since `HopeAPIError` stores response headers verbatim otherwise.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'x-api-key', 'x-service-token', 'x-service-account-token', 'cookie']);

/**
 * Anything the `Headers` constructor itself accepts. `@types/node`'s fetch
 * globals (`web-globals/fetch.d.ts`) declare `Headers`/`Request`/`Response`
 * globally but do NOT re-export a global `HeadersInit` type alias — this is
 * the local stand-in, shared by `redactHeaders` and `core/transport.ts`.
 */
export type HeaderInput = Headers | Record<string, string> | [string, string][];

/**
 * Return a NEW `Headers` object with every sensitive header's value replaced
 * by `"[REDACTED]"` (matching case-insensitively — HTTP header names are
 * case-insensitive). Non-sensitive headers pass through unchanged. Accepts
 * anything `Headers` itself accepts (a plain object, a `Headers` instance,
 * an entries array) plus `null`/`undefined` (→ an empty `Headers`).
 */
export function redactHeaders(headers: HeaderInput | null | undefined): Headers {
  const result = new Headers();
  if (!headers) return result;
  const source = headers instanceof Headers ? headers : new Headers(headers);
  for (const [key, value] of source.entries()) {
    result.set(key, SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED_PLACEHOLDER : value);
  }
  return result;
}

/**
 * The well-known symbol Node's `util.inspect` looks for. Referenced via
 * `Symbol.for` (the well-known symbol registry) instead of
 * `import 'node:util'` — this package ships zero runtime dependencies and no
 * Node-builtin imports, so it also works unmodified on Bun/Deno/edge runtimes
 * that implement the same registry lookup without shipping `node:util` at all.
 *
 * Exported so any other class that must be un-loggable (e.g.
 * `core/service-account-token.ts`'s provider) installs the SAME hook rather
 * than re-deriving the symbol and drifting from it.
 */
export const NODE_INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * Wraps a value so it can never be accidentally logged. `toString()`,
 * `toJSON()` (used by `JSON.stringify`), and Node's `util.inspect` custom
 * hook all return the literal string `"[REDACTED]"` no matter what `T` is —
 * this is what makes "never log request/response bodies" structural rather
 * than a rule someone has to remember. Call {@link RedactedValue.reveal}
 * when — and only when — you deliberately need the real value (e.g. to read
 * one non-secret field out of a response body); never pass the result of
 * `reveal()` to a logger.
 */
export class RedactedValue<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Explicit, intentional escape hatch. Never pass the result to a logger. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED_PLACEHOLDER;
  }

  toJSON(): string {
    return REDACTED_PLACEHOLDER;
  }

  [NODE_INSPECT_CUSTOM](): string {
    return REDACTED_PLACEHOLDER;
  }
}

/** Wrap `value` so it is structurally unreachable through logging/serialization. See {@link RedactedValue}. */
export function redact<T>(value: T): RedactedValue<T> {
  return new RedactedValue(value);
}
