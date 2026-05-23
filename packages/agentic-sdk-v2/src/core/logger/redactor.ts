/**
 * @arcaai/vox - PHI Redactor (TASK-266 W0-2)
 *
 * Defense-in-depth PHI scrubbing for log payloads. `redactPHI()` recursively
 * walks any structured value, returns a deep clone with values for known PHI
 * keys replaced with `'[REDACTED]'`, and rewrites `data:`, `blob:`, and
 * `file:` URL strings to `'[REDACTED-URL]'`.
 *
 * Why a separate module:
 *   - Applied uniformly by `SDKLogger` BEFORE the entry reaches any transport
 *     (highlight, loki, otel, console, custom). A single source of truth.
 *   - Independent of the existing top-level redact list on `attributes` —
 *     PHI may show up nested in `sdk`, `user`, `attributes`, error stacks, or
 *     arbitrary `meta` blobs.
 *   - Pure function; no transport coupling, no logger state.
 *
 * Constraints:
 *   - MUST NOT mutate the input value.
 *   - MUST handle circular references without throwing.
 *   - MUST preserve `Date` (returned as-is — it's immutable) and `Error`
 *     instances (returned as plain `{ name, message, stack }`) so transports
 *     get a stable shape.
 *   - MUST treat `ArrayBuffer` / typed arrays / Blob / File as opaque
 *     PHI-bearing payloads and reduce them to a marker string. Audio buffers
 *     are PHI in this codebase.
 */

/**
 * Canonical list of PHI key names. Lookup is case-sensitive (matches the
 * existing camelCase convention across SDK call sites).
 *
 * Drawn from the TASK-266 brief plus a few obvious extensions
 * (`patientName`, `doctorName`, `mrn`, `ssn`, `password`, tokens) that
 * `SDKLogger.DEFAULT_PHI_REDACT_FIELDS` already covered. The merged set
 * preserves backwards compatibility with the pre-W0-2 redaction surface.
 */
export const PHI_KEYS: readonly string[] = Object.freeze([
  // TASK-266 W0-2 explicit list
  'patientId',
  'doctorId',
  'consultationId',
  'transcript',
  'transcriptText',
  'sttText',
  'sttResult',
  'audioBuffer',
  'audioBlob',
  'recording',
  'voiceEmbedding',
  'email',
  'phone',
  'dob',
  'nationalId',
  // Carryover from the previous DEFAULT_PHI_REDACT_FIELDS list. Keeping the
  // superset preserves existing test expectations (SDKLogger SEC-03 case).
  'patientName',
  'doctorName',
  'ssn',
  'dateOfBirth',
  'mrn',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'apiKey',
]);

export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED_URL_VALUE = '[REDACTED-URL]';

const URL_PREFIXES_TO_REDACT = ['data:', 'blob:', 'file:'] as const;

const PHI_KEY_SET = new Set<string>(PHI_KEYS);

/**
 * Recursively redact PHI from any value. Returns a deep clone — the input is
 * never mutated.
 *
 * Extra redaction surface area beyond PHI key names:
 *   - String values starting with `data:`, `blob:`, or `file:` become
 *     `'[REDACTED-URL]'`. These embed raw audio/image bytes inline and are
 *     the largest single leak risk in browser logs.
 *   - `ArrayBuffer`, typed arrays, `Blob`, `File`, `MediaStream`, and
 *     `AudioBuffer` are reduced to `'[REDACTED-BINARY:<typeName>]'`.
 *   - `Error` instances are serialised to `{ name, message, stack }` (stack
 *     is preserved because it is useful for debugging and rarely contains
 *     PHI; it is itself subject to the URL-prefix redaction).
 *
 * @param input  Any JS value (object, array, primitive, Error, Blob, ...).
 * @param customKeys  Optional additional key names to redact on top of
 *   `PHI_KEYS`. The SDKLogger feeds its user-configured `redactFields` here.
 * @returns deep clone with redactions applied.
 */
export function redactPHI(input: unknown, customKeys?: readonly string[]): unknown {
  const keySet = customKeys && customKeys.length > 0 ? new Set<string>([...PHI_KEY_SET, ...customKeys]) : PHI_KEY_SET;
  return walk(input, keySet, new WeakMap<object, unknown>());
}

function walk(value: unknown, keySet: Set<string>, seen: WeakMap<object, unknown>): unknown {
  // Primitives and null/undefined.
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return redactUrlString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') {
    // Functions and symbols are never carried through to transports; reduce
    // to a marker so JSON serialization stays stable.
    return `[${t}:${(value as { name?: string }).name ?? 'anonymous'}]`;
  }

  // From here on, value is an object. Cycle break.
  const obj = value as object;
  const cached = seen.get(obj);
  if (cached !== undefined) return cached;

  // Special-case browser/binary types — opaque PHI markers.
  if (typeof Blob !== 'undefined' && obj instanceof Blob) {
    return `[REDACTED-BINARY:Blob:${(obj as Blob).size}]`;
  }
  if (obj instanceof ArrayBuffer) {
    return `[REDACTED-BINARY:ArrayBuffer:${(obj as ArrayBuffer).byteLength}]`;
  }
  if (ArrayBuffer.isView(obj)) {
    const view = obj as ArrayBufferView;
    return `[REDACTED-BINARY:${view.constructor.name}:${view.byteLength}]`;
  }

  // Errors — flatten to a serialisable shape that downstream transports rely
  // on. Walk message/stack/cause through redaction so URLs inside them are
  // scrubbed.
  if (obj instanceof Error) {
    const err = obj as Error & { code?: unknown; cause?: unknown };
    const flat: Record<string, unknown> = {
      name: err.name,
      message: typeof err.message === 'string' ? redactUrlString(err.message) : err.message,
      stack: typeof err.stack === 'string' ? redactUrlString(err.stack) : err.stack,
    };
    if (err.code !== undefined) flat.code = walk(err.code, keySet, seen);
    if (err.cause !== undefined) flat.cause = walk(err.cause, keySet, seen);
    seen.set(obj, flat);
    return flat;
  }

  // Date — immutable wall-clock value, safe to pass through.
  if (obj instanceof Date) return obj;

  // Map / Set — convert to plain forms (transports JSON-encode).
  if (obj instanceof Map) {
    const result: Record<string, unknown> = {};
    seen.set(obj, result);
    for (const [k, v] of obj.entries()) {
      const key = String(k);
      result[key] = keySet.has(key) ? REDACTED_VALUE : walk(v, keySet, seen);
    }
    return result;
  }
  if (obj instanceof Set) {
    const result: unknown[] = [];
    seen.set(obj, result);
    for (const v of obj.values()) result.push(walk(v, keySet, seen));
    return result;
  }

  // Arrays.
  if (Array.isArray(obj)) {
    const result: unknown[] = [];
    seen.set(obj, result);
    for (let i = 0; i < obj.length; i++) result[i] = walk(obj[i], keySet, seen);
    return result;
  }

  // Plain objects (and anything else with own enumerable keys).
  const result: Record<string, unknown> = {};
  seen.set(obj, result);
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (keySet.has(key)) {
      result[key] = REDACTED_VALUE;
    } else {
      result[key] = walk((obj as Record<string, unknown>)[key], keySet, seen);
    }
  }
  return result;
}

function redactUrlString(s: string): string {
  // Cheap prefix check — avoids regex on every log line.
  for (let i = 0; i < URL_PREFIXES_TO_REDACT.length; i++) {
    const prefix = URL_PREFIXES_TO_REDACT[i];
    if (s.length >= prefix.length && s.startsWith(prefix)) return REDACTED_URL_VALUE;
  }
  return s;
}
