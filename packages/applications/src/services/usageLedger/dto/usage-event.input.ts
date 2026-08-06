import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import type { UsageAttributes } from '../usage-attributes';
import type { UsageOperation } from '../vocabulary';

/**
 * `UsageEventInput` — THE FROZEN EMISSION CONTRACT (TASK-615 WS-B).
 *
 * Every wave-1 emitter (WS-C STT, WS-D SMR/guardrail, WS-E TTS/NLP, WS-F
 * harness) builds this shape and nothing else. It is deliberately NOT a
 * class-validator DTO: it never crosses an HTTP boundary, it is constructed in
 * process by a service, and its validation is `recordUsage`'s own (which
 * reports every violation at once rather than the first).
 *
 * GRAIN: one input = one ledger row = one (request, unit) pair. A single LLM
 * call produces several of these sharing a `requestId` — use the
 * {@link UsageEventBatchInput} form rather than hand-writing them.
 */
export interface UsageEventInput {
  /** Owning tenant. Required — usage that cannot be attributed is not recorded. */
  tenantId: string;

  /**
   * Intent-derived unique key — see `idempotency-keys.ts`. NEVER random, and
   * the abort path uses the SAME key the completion path would.
   */
  idempotencyKey: string;

  /**
   * When the usage HAPPENED (not when it was observed). This selects the price
   * row that applies, so an abort-path or backfilled event stays priced at the
   * rate in force at the time of the work. A `Date` or an ISO-8601 string.
   */
  occurredAt: Date | string;

  capability: AiCapability;
  /** One of the ten frozen operations — see `vocabulary.ts`. */
  operation: UsageOperation;
  /** Engine id for self-hosted, connection id for cloud/BYOK — see `vocabulary.ts`. */
  provider: string;
  /** Null for capabilities that select no model (a raw STT audio-second row). */
  model?: string | null;
  /** Carries the economic meaning: platform-funded, cloud, or tenant-funded. */
  deployment: AiDeploymentKind;

  unit: AiUsageUnit;
  /** Non-negative. A string when fractional, so JSON never rounds it. */
  quantity: number | string;

  /**
   * Defaults to `INTERNAL`. BYOK emitters MUST pass `BYOK_NOTIONAL` explicitly:
   * nothing derives it from `deployment`, because a silent derivation makes a
   * forgotten flag invisible, and the default's direction of error
   * (over-reporting platform spend) is the safe one.
   */
  costBasis?: AiCostBasis;

  // ── attribution (ids only, never names) ────────────────────────────────────
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
  /** Ties every unit row of one provider call together. */
  requestId?: string | null;
  sessionId?: string | null;

  /** Allow-listed dimensions ONLY — see `usage-attributes.ts`. */
  attributesJson?: UsageAttributes | null;
}

/** One unit line inside a {@link UsageEventBatchInput}. */
export interface UsageUnitInput {
  unit: AiUsageUnit;
  quantity: number | string;
  /** Merged OVER `common.attributesJson` for this row only. */
  attributesJson?: UsageAttributes | null;
}

/**
 * The multi-unit convenience shape: one logical AI call, several unit rows.
 *
 * `common.idempotencyKey` is the BASE key (e.g. `llm:<requestId>`); expansion
 * appends `:<UNIT>` to produce the per-row key documented in the contract.
 * Units whose quantity is zero are DROPPED — most requests use no cache and no
 * reasoning tokens, and rows recording "nothing happened" would triple the
 * ledger.
 */
export interface UsageEventBatchInput {
  common: Omit<UsageEventInput, 'unit' | 'quantity'>;
  units: UsageUnitInput[];
}

/** What `recordUsage` reports back. */
export interface RecordUsageResult {
  /** One id per outbox row written (one per distinct tenant in the call). */
  outboxIds: string[];
  /** How many ledger rows the drainer will attempt to append. */
  events: number;
}
