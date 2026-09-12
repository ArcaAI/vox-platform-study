import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import type { UsageAttributes } from '../usage-attributes';
import type { UsageOperation } from '../vocabulary';

/**
 * The JSONB envelope stored in `AiUsageOutbox.payload`.
 *
 * TWO THINGS ARE NOT PLAIN JSON in a `UsageEventInput`, and both are money-
 * critical, so both are serialised explicitly:
 *
 *   - `occurredAt` — a `Date` becomes an ISO string. JSON.parse would otherwise
 *     hand the drainer a string it might quietly treat as a Date.
 *   - `quantity` — always a STRING. A JSON number is an IEEE double, and
 *     `12.345678` audio seconds multiplied by a price is exactly where float
 *     drift turns into money drift.
 *
 * `version` exists so the drainer can refuse a payload shape it does not
 * understand instead of silently mis-reading one. A row written by an older
 * deploy must never be re-interpreted by a newer drainer on a guess.
 */
export const USAGE_OUTBOX_PAYLOAD_VERSION = 1 as const;

/** One event, as it survives a JSONB round trip. */
export interface SerializedUsageEvent {
  tenantId: string;
  idempotencyKey: string;
  /** ISO-8601, UTC. */
  occurredAt: string;
  capability: AiCapability;
  operation: UsageOperation;
  provider: string;
  model: string | null;
  deployment: AiDeploymentKind;
  unit: AiUsageUnit;
  /** Decimal as a string — never a JSON number. */
  quantity: string;
  costBasis: AiCostBasis;
  /** TASK-958 D-7 — the `AiProviderConnection` that was spent; `null` when none was named. */
  connectionId: string | null;
  consultationId: string | null;
  doctorId: string | null;
  departmentId: string | null;
  requestId: string | null;
  sessionId: string | null;
  attributesJson: UsageAttributes | null;
}

export interface UsageOutboxPayload {
  version: typeof USAGE_OUTBOX_PAYLOAD_VERSION;
  events: SerializedUsageEvent[];
}
