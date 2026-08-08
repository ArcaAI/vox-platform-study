/**
 * Backend PHI log redaction (TASK-636 OBS-19).
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
]);

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

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function buildKeySet(extra: readonly string[] = []): Set<string> {
  return new Set([...PHI_KEYS, ...extra].map(normalizeKey));
}

function isBinary(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

function redactString(value: string): string {
  // `replace` with a /g/ regex resets lastIndex itself, so the shared literal
  // is safe to reuse across calls.
  return value.replace(OPAQUE_URL, REDACTED_URL);
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

function walk(value: unknown, keys: Set<string>, seen: WeakMap<object, unknown>): unknown {
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
    const entries = Object.entries(value);
    let changed = redactedMessage !== value.message;

    const extras: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (keys.has(normalizeKey(k))) {
        extras[k] = REDACTED_VALUE;
        changed = true;
      } else {
        const walked = walk(v, keys, seen);
        extras[k] = walked;
        if (walked !== v) changed = true;
      }
    }

    if (!changed) {
      seen.set(asObject, value);
      return value;
    }

    // Rebuild as a real Error so `instanceof Error` still holds — both
    // `base.transport.formatError` and `console.transport` branch on it.
    const clone = new Error(redactedMessage);
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
      const walked = walk(item, keys, seen);
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
    if (keys.has(normalizeKey(k))) {
      out[k] = REDACTED_VALUE;
      changed = true;
    } else {
      const walked = walk(v, keys, seen);
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


