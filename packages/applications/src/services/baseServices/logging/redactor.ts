/**
 * Backend PHI log redaction.
 *
 * WHY THIS EXISTS
 * `LoggingConfig.redactFields?: string[]` was declared in `transports/types.ts`
 * and never read — zero call sites. On a multi-tenant healthcare platform that
 * meant every backend log line reached console, file, Loki, Highlight and the
 * OTel bridge completely unredacted. Only the BROWSER SDK
 * (`@arcaai/vox` `core/logger/redactor.ts`) ever implemented redaction.
 *
 * This mirrors the SDK module's vocabulary and guarantees on purpose: one PHI
 * key list and one set of semantics across both runtimes, so a reviewer does
 * not have to hold two mental models. It is intentionally a *copy* rather than
 * a shared import — `packages/applications` is server-side NestJS and must not
 * take a dependency on a browser SDK that ships `"use client"` on every entry.
 *
 * Applied at the single `dispatch()` chokepoint in `logging.service.ts`, BEFORE
 * any transport sees the entry — the same placement the SDK uses. Redacting per
 * transport would mean every future transport re-implements it and one of them
 * eventually forgets.
 *
 * GUARANTEES
 *   - Never mutates the input.
 *   - Never throws on circular references.
 *   - **Returns the ORIGINAL reference when nothing needed redacting.** This is
 *     load-bearing, not an optimisation: `Error` instances must survive as
 *     `Error` (both `base.transport.formatError` and `console.transport` branch
 *     on `instanceof Error`), and callers that compare identity keep working.
 *     It also means the overwhelmingly common clean log line costs no clone.
 *     When redaction IS needed, an `Error` is rebuilt as a real `Error`.
 *   - Treats binary payloads (ArrayBuffer / typed arrays / Buffer) as opaque
 *     PHI: audio buffers ARE PHI in this codebase.
 *   - Rewrites `data:` / `blob:` / `file:` URLs, which can carry an entire
 *     recording inline.
 *   - Preserves `tenantId` / `userId` / `traceId` / `spanId` / `requestId`:
 *     these are how an operator FINDS a log line. They are internal
 *     identifiers, not PHI, and redacting them would make the telemetry
 *     useless without protecting anything.
 */

import { redactId } from './redact-id';
import type { LogEntry } from './transports/types';

/**
 * Canonical PHI key names. Kept in sync with the SDK's `PHI_KEYS`
 * (`packages/agentic-sdk-v2/src/core/logger/redactor.ts`) — if you add a key
 * in one place, add it in the other.
 *
 * Lookup is case-insensitive here (unlike the SDK's camelCase-only matching):
 * backend payloads arrive from Prisma rows, HTTP bodies and Python services,
 * so `patient_id`, `PatientId` and `patientId` all occur in practice.
 */
export const PHI_KEYS: readonly string[] = Object.freeze([
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
  'patientName',
  'doctorName',
  'ssn',
  'dateOfBirth',
  'mrn',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'passphrase',
  'apiKey',
  // Backend-only additions: these appear in server payloads but never in the
  // browser SDK's surface.
  'summaryText',
  'preSummaryText',
  'noteText',
  'clinicalNote',
  'secret',
  'privateKey',
  'authorization',
  // Credential headers, as they appear when a request or response object is
  // logged whole. Keys are normalised (lower-case, `-`/`_` stripped) before
  // matching, so `set-cookie` and `x-api-key` match their header spelling.
  'cookie',
  'set-cookie',
  'x-service-token',
  'x-api-key',
  // Direct identifiers and clinical free text.
  'firstName',
  'lastName',
  'fullName',
  'address',
  'prompt',
  'completion',
  // Deliberately NOT listed: `text`, `body`, `content`, `name`. They are the
  // names of operational fields (a route's body shape, a queue's name, a
  // provider's content type) far more often than of PHI, and blanking them
  // would make the lines that explain an incident unreadable. PHI inside them
  // is still caught by the value patterns below.
]);

/**
 * Key PREFIXES treated as PHI: every `phone*` field (`phone`, `phoneNumber`,
 * `phone_number`, `phoneMobile`) without enumerating each spelling.
 */
const PHI_KEY_PREFIXES: readonly string[] = Object.freeze(['phone']);

/**
 * Clinical identifiers that are HASHED with `redactId` instead of blanked:
 * the line stays correlatable ("the same consultation failed three times")
 * while the raw id never reaches a log store. Same algorithm as the Python
 * fleet's `redact_id`, so the token matches across services.
 *
 * `mrn` is deliberately absent — medical record numbers are short and often
 * numeric, and an unsalted hash of a guessable value is reversible by
 * enumeration, so it stays fully `[REDACTED]`. `tenantId` / `userId` /
 * `traceId` / `requestId` are not PHI and stay raw (see the guarantees above).
 */
export const HASHED_ID_KEYS: readonly string[] = Object.freeze(['patientId', 'externalPatientId', 'consultationId']);

export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED_URL = '[REDACTED-URL]';
const REDACTED_BINARY = '[REDACTED-BINARY]';

/**
 * `data:`/`blob:`/`file:` can inline an entire recording.
 *
 * Deliberately NOT anchored to the start of the string: these URLs turn up
 * embedded in prose ("failed on data:audio/wav;base64,…"), in error messages
 * and in stack traces, not only as a whole field value.
 */
const OPAQUE_URL = /\b(data:|blob:|file:)\S+/gi;

/**
 * Value patterns for PHI and credentials that arrive INSIDE a string — an
 * email in "no user jane@x.org", a token echoed by an HTTP client error — where
 * no key name can catch them. Bearer runs before JWT so a `Bearer eyJ…` keeps
 * one marker rather than two.
 */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** How deep an `error.cause` chain is walked; anything below is dropped. */
const MAX_CAUSE_DEPTH = 5;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

interface KeyRules {
  redact: Set<string>;
  hash: Set<string>;
}

function buildKeySet(extra: readonly string[] = []): KeyRules {
  return {
    redact: new Set([...PHI_KEYS, ...extra].map(normalizeKey)),
    hash: new Set(HASHED_ID_KEYS.map(normalizeKey)),
  };
}

/**
 * What a keyed value becomes, or `undefined` when the key is not sensitive.
 * A hashed-id key wins over the PHI list (both name `patientId`), and only a
 * scalar is hashed — an object under an id key is not an id, so it is blanked.
 */
function isIdScalar(value: unknown): value is string | number | bigint | null | undefined {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
}

function redactKeyed(key: string, value: unknown, rules: KeyRules): unknown {
  const normalized = normalizeKey(key);
  if (rules.hash.has(normalized)) {
    return isIdScalar(value) ? redactId(value) : REDACTED_VALUE;
  }
  if (rules.redact.has(normalized) || PHI_KEY_PREFIXES.some((p) => normalized.startsWith(p))) {
    return REDACTED_VALUE;
  }
  return undefined;
}

function isBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value));
}

function redactString(value: string): string {
  // `replace` with a /g/ regex resets lastIndex itself, so the shared literal
  // is safe to reuse across calls.
  return value
    .replace(OPAQUE_URL, REDACTED_URL)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(JWT, '[REDACTED-JWT]')
    .replace(EMAIL, '[REDACTED-EMAIL]');
}

/**
 * Deep-clone `value`, replacing PHI-keyed values with `[REDACTED]`.
 *
 * @param extraKeys additional field names to treat as PHI — this is what makes
 *   the long-declared `LoggingConfig.redactFields` finally load-bearing.
 */
export function redactValue(value: unknown, extraKeys: readonly string[] = []): unknown {
  return walk(value, buildKeySet(extraKeys), new WeakMap());
}

function walk(value: unknown, keys: KeyRules, seen: WeakMap<object, unknown>, causeDepth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (isBinary(value)) return REDACTED_BINARY;
  // Immutable and safe to pass through — cloning would lose the type.
  if (value instanceof Date) return value;

  const asObject = value as object;
  const cached = seen.get(asObject);
  if (cached !== undefined) return cached;

  if (value instanceof Error) {
    // Errors routinely carry extra enumerable properties (Nest and Axios
    // attach request bodies), and those are exactly where PHI hides.
    const redactedMessage = redactString(value.message);
    let changed = redactedMessage !== value.message;

    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // `cause` is walked below with a depth bound, whether or not it was
      // assigned as an enumerable property.
      if (k === 'cause') continue;
      const keyed = redactKeyed(k, v, keys);
      if (keyed !== undefined) {
        extras[k] = keyed;
        changed = true;
      } else {
        const walked = walk(v, keys, seen, causeDepth);
        extras[k] = walked;
        if (walked !== v) changed = true;
      }
    }

    // `new Error(msg, { cause })` makes `cause` NON-enumerable, so the loop
    // above never sees it — and a clean outer error used to hand a
    // PHI-bearing cause to the transport untouched.
    const hasCause = 'cause' in value && (value as { cause?: unknown }).cause !== undefined;
    let cause: unknown;
    if (hasCause) {
      const original = (value as { cause?: unknown }).cause;
      if (causeDepth >= MAX_CAUSE_DEPTH) {
        cause = undefined;
        changed = true;
      } else {
        cause = walk(original, keys, seen, causeDepth + 1);
        if (cause !== original) changed = true;
      }
    }

    if (!changed) {
      seen.set(asObject, value);
      return value;
    }

    // Rebuild as a real Error so `instanceof Error` still holds — both
    // `base.transport.formatError` and `console.transport` branch on it.
    const clone = new Error(redactedMessage);
    if (cause !== undefined) {
      // Same shape as `new Error(msg, { cause })`: an own, non-enumerable property.
      Object.defineProperty(clone, 'cause', { value: cause, writable: true, configurable: true, enumerable: false });
    }
    clone.name = value.name;
    // The stack embeds the original message verbatim, so it needs the same
    // treatment or a PHI-bearing message survives in the stack string.
    clone.stack = value.stack ? redactString(value.stack) : value.stack;
    seen.set(asObject, clone);
    Object.assign(clone, extras);
    return clone;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(asObject, out);
    let changed = false;
    for (const item of value) {
      const walked = walk(item, keys, seen, causeDepth);
      if (walked !== item) changed = true;
      out.push(walked);
    }
    if (!changed) {
      seen.set(asObject, value);
      return value;
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(asObject, out);
  let changed = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keyed = redactKeyed(k, v, keys);
    if (keyed !== undefined) {
      out[k] = keyed;
      changed = true;
    } else {
      const walked = walk(v, keys, seen, causeDepth);
      out[k] = walked;
      if (walked !== v) changed = true;
    }
  }
  if (!changed) {
    seen.set(asObject, value);
    return value;
  }
  return out;
}

/**
 * Redact a log entry in place of its PHI-bearing parts.
 *
 * Only `message`, `meta` and `error` are walked. The remaining fields are
 * level/timestamp/correlation identifiers — see the guarantee about preserving
 * `tenantId`/`userId`/`traceId` above.
 */
export function redactEntry(entry: LogEntry, extraKeys: readonly string[] = []): LogEntry {
  const keys = buildKeySet(extraKeys);
  const seen = new WeakMap<object, unknown>();

  const redacted: LogEntry = { ...entry };

  if (typeof entry.message === 'string') {
    redacted.message = redactString(entry.message);
  }
  if (entry.meta) {
    redacted.meta = walk(entry.meta, keys, seen) as Record<string, unknown>;
  }
  if (entry.error) {
    redacted.error = walk(entry.error, keys, seen) as LogEntry['error'];
  }

  return redacted;
}
