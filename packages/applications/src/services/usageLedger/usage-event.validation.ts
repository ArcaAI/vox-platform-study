import Decimal from 'decimal.js';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import type { SerializedUsageEvent, UsageEventBatchInput, UsageEventInput } from './dto';
import { validateIdempotencyKey } from './idempotency-keys';
import { validateUsageAttributes } from './usage-attributes';
import { isUsageOperation, validateProviderId } from './vocabulary';

/**
 * Validation, batch expansion and serialisation for the emission contract.
 *
 * PURE — no repository, no clock. The rules that decide whether an event is
 * admissible have to be readable on their own, and every wave-1 emitter lane
 * needs to be able to unit-test its payloads without standing up a service.
 *
 * The posture throughout is DERIVE NOTHING SILENTLY. Every field an emitter
 * omits is either optional-by-contract or an exception — never a value this
 * module invents. A guessed `costBasis` or a defaulted `occurredAt` produces an
 * invoice line nobody can explain and no evidence trail to explain it with.
 */

/**
 * Expand the `{common, units}` shape into one input per unit.
 *
 * - The per-row idempotency key is `common.idempotencyKey` + `:<UNIT>`.
 * - Per-unit `attributesJson` is merged OVER the common bag.
 * - **Zero-quantity units are dropped.** Most requests use no cache and no
 *   reasoning tokens; emitting rows that record "nothing happened" would
 *   triple the ledger's row count and every rollup built on it. A unit that is
 *   genuinely zero-but-meaningful is emitted as a plain `UsageEventInput`,
 *   where the caller's intent is explicit.
 */
export function expandUsageBatch(batch: UsageEventBatchInput): UsageEventInput[] {
  const { common, units } = batch;

  return units
    .filter((line) => !isZeroQuantity(line.quantity))
    .map((line) => ({
      ...common,
      idempotencyKey: `${common.idempotencyKey}:${line.unit}`,
      unit: line.unit,
      quantity: line.quantity,
      attributesJson:
        common.attributesJson || line.attributesJson ? { ...(common.attributesJson ?? {}), ...(line.attributesJson ?? {}) } : (common.attributesJson ?? null),
    }));
}

/**
 * Validate one emission input.
 *
 * @returns EVERY violation found. Never short-circuits: an emitter with three
 *          mistakes fixes three mistakes in one pass instead of discovering
 *          them one deploy at a time.
 */
export function validateUsageEventInput(input: UsageEventInput): string[] {
  const violations: string[] = [];

  if (typeof input.tenantId !== 'string' || input.tenantId.trim().length === 0) {
    violations.push('tenantId is required — usage that cannot be attributed is not recorded');
  }

  violations.push(...validateIdempotencyKey(input.idempotencyKey));

  if (parseOccurredAt(input.occurredAt) === null) {
    violations.push('occurredAt must be a valid Date or ISO-8601 string');
  }

  if (!isEnumMember(AiCapability, input.capability)) {
    violations.push(`capability "${String(input.capability)}" is not a known AiCapability`);
  }

  if (!isUsageOperation(input.operation)) {
    violations.push(`operation "${String(input.operation)}" is not one of the frozen usage operations (see vocabulary.ts)`);
  }

  violations.push(...validateProviderId(input.provider));

  if (input.model !== undefined && input.model !== null && (typeof input.model !== 'string' || input.model.length === 0 || input.model.length > 128)) {
    violations.push('model must be a non-empty string of at most 128 characters, or null');
  }

  if (!isEnumMember(AiDeploymentKind, input.deployment)) {
    violations.push(`deployment "${String(input.deployment)}" is not a known AiDeploymentKind`);
  }

  if (!isEnumMember(AiUsageUnit, input.unit)) {
    violations.push(`unit "${String(input.unit)}" is not a known AiUsageUnit`);
  }

  violations.push(...validateQuantity(input.quantity));

  if (input.costBasis !== undefined && !isEnumMember(AiCostBasis, input.costBasis)) {
    violations.push(`costBasis "${String(input.costBasis)}" is not a known AiCostBasis`);
  }

  for (const field of ['consultationId', 'doctorId', 'departmentId', 'requestId', 'sessionId'] as const) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      violations.push(`${field} must be a non-empty id of at most 128 characters, or null`);
    }
  }

  violations.push(...validateUsageAttributes(input.attributesJson));

  return violations;
}

/**
 * Freeze a validated input into its JSONB form.
 *
 * Call ONLY after {@link validateUsageEventInput} has passed — `occurredAt` is
 * assumed parseable here, and quantity is assumed numeric.
 */
export function serializeUsageEvent(input: UsageEventInput): SerializedUsageEvent {
  const occurredAt = parseOccurredAt(input.occurredAt);
  if (occurredAt === null) {
    throw new Error('serializeUsageEvent: occurredAt must be validated before serialisation');
  }

  return {
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: occurredAt.toISOString(),
    capability: input.capability,
    operation: input.operation,
    provider: input.provider,
    model: input.model ?? null,
    deployment: input.deployment,
    unit: input.unit,
    // Always a STRING: a JSON number is an IEEE double, and fractional audio
    // seconds multiplied by a price is exactly where float drift becomes money.
    quantity: new Decimal(input.quantity).toString(),
    costBasis: input.costBasis ?? AiCostBasis.INTERNAL,
    consultationId: input.consultationId ?? null,
    doctorId: input.doctorId ?? null,
    departmentId: input.departmentId ?? null,
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
    attributesJson: input.attributesJson ?? null,
  };
}

/** A `Date` or ISO string in, a valid `Date` or `null` out. */
export function parseOccurredAt(value: Date | string | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateQuantity(value: unknown): string[] {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return ['quantity must be a number or a numeric string'];
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return ['quantity must be a finite number'];
  }
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    return [`quantity "${String(value)}" is not a valid decimal`];
  }
  if (!parsed.isFinite()) return ['quantity must be finite'];
  // A negative quantity is always a normalizer bug, and the entity would throw
  // on it anyway — catching it here keeps the whole batch from being lost.
  if (parsed.isNegative()) return ['quantity must not be negative'];
  return [];
}

function isZeroQuantity(value: number | string): boolean {
  try {
    return new Decimal(value).isZero();
  } catch {
    // Not a number at all — let validation report it rather than dropping it.
    return false;
  }
}

function isEnumMember(enumObject: Record<string, string>, value: unknown): boolean {
  return typeof value === 'string' && Object.values(enumObject).includes(value);
}
