import Decimal from 'decimal.js';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { truncateToUtcDay } from './billing-period';
import { DailyUnitQuantity } from './invoice-math';

/**
 * Billable-usage construction (D13/D16/OQ1).
 *
 * ============================================================================
 * WHY ROLLUPS ALONE ARE NOT ENOUGH — the `operation` dimension gap
 * ============================================================================
 * Invoice computation reads `AiUsageRollupDaily` (D13 — never raw events), but
 * the rollup dimension tuple is (day, capability, provider, model, unit): it
 * carries NO `operation`. Two binding rules are operation-shaped:
 *
 *   - **D16** — `guardrail.validate` and `harness.step` usage lands under
 *     capability LLM (same providers, same models as tenant generation) and is
 *     metered for COGS but must NEVER be billed to a tenant.
 *   - **OQ1** — STT streaming bills on SESSION seconds; its AUDIO seconds are
 *     recorded for repricing only. Batch STT emits ONLY audio-seconds. The
 *     rollup AUDIO_SECOND bucket mixes both, so it cannot be billed as-is.
 *
 * The rollup grain DID grow an `operation` dimension,
 * but rows written before that migration carry the `""` sentinel, so the
 * compensation path stays: it is the only thing that reads those historical
 * buckets correctly. The engine takes a bounded LEDGER AGGREGATE (SQL
 * `SUM(quantity) GROUP BY day, unit, operation, provider, deployment` filtered
 * by operation, via `BillingUsageAggregateRepository`; an indexed aggregate,
 * not row reads) and merges it here:
 *
 *   - LLM:  rollup pool MINUS the non-billable-operation sums (clamped ≥ 0).
 *   - STT:  SESSION_SECOND straight from rollups (pure streaming), while
 *           AUDIO_SECOND is REPLACED by the `transcribe.batch`-only sums.
 *
 * Failure direction: if the compensating aggregate errored we would OVER-bill,
 * so the service lets that error propagate — a draft that cannot be computed
 * correctly is not computed at all.
 *
 * BYOK (D14): rollup `quantitySum` already includes BYOK-funded units, and
 * that is CORRECT here — overage quantity counts metered units regardless of
 * `costBasis`; only the notional COST is excluded (and surfaced separately on
 * the DTO, never as a line).
 */

/** The billing denomination of each capability (D11 allowance columns). */
export const BILLABLE_UNITS: Record<AiCapability, readonly AiUsageUnit[]> = {
  // OQ1: session-seconds for streaming; audio-seconds ONLY from batch (replaced source).
  [AiCapability.STT]: [AiUsageUnit.SESSION_SECOND, AiUsageUnit.AUDIO_SECOND],
  // All billable token kinds pool into `monthlyLlmTokens`. GPU_SECOND is the
  // self-hosted cost-truth unit and is never sold (research ).
  [AiCapability.LLM]: [
    AiUsageUnit.INPUT_TOKEN,
    AiUsageUnit.OUTPUT_TOKEN,
    AiUsageUnit.CACHE_READ_TOKEN,
    AiUsageUnit.CACHE_WRITE_TOKEN,
    AiUsageUnit.REASONING_TOKEN,
  ],
  [AiCapability.TTS]: [AiUsageUnit.CHARACTER],
  // REQUEST rows are a shape metric (seeded at 0 cost) — text units carry NLP billing.
  [AiCapability.NLP]: [AiUsageUnit.TEXT_UNIT],
  [AiCapability.EMBEDDING]: [AiUsageUnit.INPUT_TOKEN],
  // TASK-959 W0 — EMPTY ON PURPOSE, and it must stay empty until wave 4.
  //
  // The two new capabilities are metered from the day their emitters ship, but
  // a billable unit with no SELL row makes `BillingService` THROW
  // (`MissingSellRateError` → 409), which aborts the whole invoice draft — not
  // just that line. The ticket's §2.3 gate is exactly this: emit first (rows
  // land, unrated at worst, and show on the consumption screen), price second,
  // sell third. An empty list here is what keeps `STORAGE_GB_DAY` and the
  // `WORKFLOW` CPU seconds VISIBLE and un-invoiced in the meantime.
  //
  // Adding a unit here is therefore a wave-4 act that ships WITH its SELL row
  // and its allowance column (`monthlyStorageGbDays`,
  // `monthlyWorkflowCpuSeconds`), never before.
  [AiCapability.STORAGE]: [],
  [AiCapability.WORKFLOW]: [],
};

/** D16 — metered for COGS, never line-itemed to tenants. */
export const NON_BILLABLE_LLM_OPERATIONS: readonly string[] = ['guardrail.validate', 'harness.step'];

/** The STT operation whose AUDIO_SECOND rows ARE billable (OQ1). */
export const STT_BATCH_OPERATION = 'transcribe.batch';

/**
 * Per-(day, unit, provider, deployment) sums, already summed across `model`.
 *
 * `provider` and `deployment` survive into billing because the pooled
 * allowance is consumed SELF_HOSTED-first and the SELL rate is resolved per
 * provider. Collapsing them here — as this type did before — is what made a
 * managed-ASR premium unpriceable.
 */
export interface DayUnitSum {
  day: Date;
  unit: AiUsageUnit;
  provider: string;
  deployment: AiDeploymentKind;
  quantity: Decimal;
}

export interface OperationCompensation {
  /** Sums to SUBTRACT from the rollup pool per (day, unit) — clamped at 0. */
  subtract?: readonly DayUnitSum[];
  /** Units whose rollup buckets are DISCARDED and replaced by these sums. */
  replace?: readonly DayUnitSum[];
}

/**
 * Merge rollup sums with the operation compensation into the billable
 * (day, unit) quantities the overage engine consumes. Pure; deterministic
 * output order (day, then canonical unit order); zero/negative results drop.
 */
export function buildBillableUsage(
  capability: AiCapability,
  rollups: readonly DayUnitSum[],
  compensation: OperationCompensation = {},
): DailyUnitQuantity[] {
  const billableUnits = new Set(BILLABLE_UNITS[capability]);
  const replacedUnits = new Set((compensation.replace ?? []).map((entry) => entry.unit));
  // STT's AUDIO_SECOND is replace-sourced even when no batch jobs ran — the
  // streaming audio-seconds in the rollup must never leak into billing.
  if (capability === AiCapability.STT) replacedUnits.add(AiUsageUnit.AUDIO_SECOND);

  const byKey = new Map<string, { day: Date; unit: AiUsageUnit; provider: string; deployment: AiDeploymentKind; quantity: Decimal }>();
  // (provider, deployment) are part of the key so a deduction only ever cancels
  // the SAME funded vendor's usage — subtracting guardrail's self-hosted LLM
  // tokens from a tenant's CLOUD bucket would understate premium-rated overage.
  const keyOf = (day: Date, unit: AiUsageUnit, provider: string, deployment: AiDeploymentKind): string =>
    `${truncateToUtcDay(day).getTime()}::${unit}::${provider}::${deployment}`;

  const add = (entry: DayUnitSum, sign: 1 | -1): void => {
    if (!billableUnits.has(entry.unit)) return;
    const day = truncateToUtcDay(entry.day);
    const key = keyOf(day, entry.unit, entry.provider, entry.deployment);
    const existing = byKey.get(key);
    const delta = sign === 1 ? entry.quantity : entry.quantity.negated();
    byKey.set(key, {
      day,
      unit: entry.unit,
      provider: entry.provider,
      deployment: entry.deployment,
      quantity: (existing?.quantity ?? new Decimal(0)).plus(delta),
    });
  };

  for (const entry of rollups) {
    if (replacedUnits.has(entry.unit)) continue;
    add(entry, 1);
  }
  for (const entry of compensation.replace ?? []) add(entry, 1);
  for (const entry of compensation.subtract ?? []) add(entry, -1);

  const unitOrder = Object.fromEntries(Object.values(AiUsageUnit).map((unit, index) => [unit, index])) as Record<AiUsageUnit, number>;

  return [...byKey.values()]
    .filter((entry) => entry.quantity.greaterThan(0)) // clamp — a deduction can never drive billable usage negative
    .sort(
      (a, b) =>
        a.day.getTime() - b.day.getTime() ||
        unitOrder[a.unit] - unitOrder[b.unit] ||
        (a.deployment < b.deployment ? -1 : a.deployment > b.deployment ? 1 : 0) ||
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
    )
    .map((entry) => ({ day: entry.day, unit: entry.unit, provider: entry.provider, deployment: entry.deployment, quantity: entry.quantity }));
}
