/**
 * The async task/event envelope. Normative prose + rationale:
 * docs/programs/agentic-workflow-platform/async-contract.md
 * Normative machine artifact: schema/async-envelope.v1.json (draft 2020-12).
 *
 * This module is a HAND-WRITTEN validator, not a JSON Schema interpreter —
 * this package stays dependency-free (no ajv, no zod), the same tradeoff
 * `@arcaai/json-schema-subset` makes and for the same reason: it is bundled
 * into consumers (`@arcaai/vox-node`, `apps/admin-console`) whose dependency
 * footprint is policed. Because a hand-written validator can silently drift
 * from the schema it is supposed to agree with, both language packages carry
 * a parity test against a shared example corpus
 * (`src/__tests__/envelope.test.ts`, `packages/py-async-contract/tests/test_parity.py`)
 * — see async-contract.md, Risk 2. Do not let that test go flaky or skipped.
 */
import { claimCheckRefProblems, type ClaimCheckRef } from './claim-check-ref';
import { idempotencyKeyProblems } from './idempotency';

/** This document defines version 1 only. A future version is a NEW constant, never a mutation of this one. */
export const ASYNC_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The envelope. `payload` and `payloadRef` are both optional at the TYPE
 * level (TypeScript has no clean XOR for object shapes without a
 * discriminated union, which would complicate every producer for a property
 * the schema already enforces); "exactly one of the two" is a RUNTIME
 * invariant, checked by {@link asyncEnvelopeProblems} and therefore by
 * {@link parseAsyncEnvelope}. Never construct one by hand without running it
 * through `asyncEnvelopeProblems` first.
 */
export interface AsyncEnvelope<TPayload = unknown> {
  schemaVersion: typeof ASYNC_ENVELOPE_SCHEMA_VERSION;
  /** The envelope's own identity. UUIDv7. */
  id: string;
  /** MANDATORY, never null. Platform-wide messages use the SYSTEM tenant, never NULL. */
  tenantId: string;
  /** Lowercase dotted, e.g. `stt.segment.finalized`. */
  type: string;
  /** ISO-8601 UTC. The FACT time, not the publish/redelivery time. */
  occurredAt: string;
  /** Request/session-scoped id, propagated unchanged across everything it causes. */
  correlationId: string;
  /** The `id` of the envelope that caused this one, or `null` when unknown/untracked. */
  causationId: string | null;
  /** Intent-derived — see ./idempotency.ts. Never random. */
  idempotencyKey: string;
  /** Inline payload. Mutually exclusive with `payloadRef`. */
  payload?: TPayload;
  /** Claim-check reference. Mutually exclusive with `payload`. */
  payloadRef?: ClaimCheckRef;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'id',
  'tenantId',
  'type',
  'occurredAt',
  'correlationId',
  'causationId',
  'idempotencyKey',
  'payload',
  'payloadRef',
]);

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Problems with a candidate envelope. Empty array = conforms. Never throws —
 * mirrors the package-level house idiom (`authorableJsonSchemaProblems`,
 * `contextSchemaDefinitionProblems`, `writeScopeProblems`, `validateIdempotencyKey`)
 * so a caller can surface every problem in one report instead of one exception
 * at a time.
 */
export function asyncEnvelopeProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['envelope must be a JSON object'];
  }
  const obj = value as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(key)) {
      problems.push(`unexpected property '${key}'`);
    }
  }

  if (obj.schemaVersion !== ASYNC_ENVELOPE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${ASYNC_ENVELOPE_SCHEMA_VERSION} (received ${JSON.stringify(obj.schemaVersion)})`);
  }
  if (typeof obj.id !== 'string' || !UUID_PATTERN.test(obj.id)) {
    problems.push('id must be a UUID string');
  }
  if (typeof obj.tenantId !== 'string' || !UUID_PATTERN.test(obj.tenantId)) {
    problems.push('tenantId must be a UUID string');
  }
  if (typeof obj.type !== 'string' || obj.type.length > 200 || !TYPE_PATTERN.test(obj.type)) {
    problems.push('type must be a lowercase dotted string of 2-5 segments matching /^[a-z0-9]+(\\.[a-z0-9_]+){1,4}$/');
  }
  if (typeof obj.occurredAt !== 'string' || !DATE_TIME_PATTERN.test(obj.occurredAt) || Number.isNaN(Date.parse(obj.occurredAt))) {
    problems.push('occurredAt must be an ISO-8601 UTC date-time string');
  }
  if (typeof obj.correlationId !== 'string' || obj.correlationId.length === 0 || obj.correlationId.length > 255) {
    problems.push('correlationId must be a non-empty string of at most 255 characters');
  }
  if (obj.causationId !== null && (typeof obj.causationId !== 'string' || !UUID_PATTERN.test(obj.causationId))) {
    problems.push('causationId must be a UUID string or null');
  }
  problems.push(...idempotencyKeyProblems(obj.idempotencyKey));

  const hasPayload = Object.prototype.hasOwnProperty.call(obj, 'payload');
  const hasPayloadRef = Object.prototype.hasOwnProperty.call(obj, 'payloadRef');
  if (hasPayload === hasPayloadRef) {
    problems.push('exactly one of payload or payloadRef must be present');
  } else if (hasPayloadRef) {
    problems.push(...claimCheckRefProblems(obj.payloadRef));
  }

  return problems;
}

/**
 * Refuse-if-unknown parse. Returns `null` for ANY conformance problem
 * (including, per, an unknown `schemaVersion`) — the caller MUST NOT
 * proceed on `null`, exactly as `UsageOutboxPayload`'s drainer refuses a
 * shape it does not understand rather than best-effort reading it.
 */
export function parseAsyncEnvelope<TPayload = unknown>(value: unknown): AsyncEnvelope<TPayload> | null {
  if (asyncEnvelopeProblems(value).length > 0) return null;
  return value as AsyncEnvelope<TPayload>;
}
