import Decimal from 'decimal.js';
import { AiCapability, TenantPlan } from '@arcaai/domains';

/**
 * Pure allowance resolution for the invoice engine (TASK-615 D11/D12).
 *
 * Chain: `PlanEntitlement` row ← `TenantEntitlement` override — a non-null
 * override field wins, a null one inherits, exactly the `pick()` precedence of
 * `resolve-entitlements.ts`. That resolver does not surface the five allowance
 * columns yet (they are WS-H's lane); this function reads THE SAME two rows,
 * so the two resolutions converge by construction and can be merged later
 * without a behavior change.
 *
 * `null` = UNLIMITED everywhere: a null plan (ungated-legacy tenant, Q3), a
 * missing row, or an unset column all resolve to "no allowance ceiling", from
 * which no overage line can ever fall out.
 *
 * UNIT NOTE (documented decision): the STT allowance `monthlySttSessionSeconds`
 * is POOLED across streaming session-seconds AND batch audio-seconds — one
 * batch audio-second consumes one second of the allowance. Batch work has no
 * session, and a second allowance column for it would be a knob nobody asked
 * for; the SELL card still prices the two units independently.
 */

/** The five allowance columns both entitlement rows carry (D11). */
export interface BillingAllowanceColumns {
  monthlySttSessionSeconds?: bigint | null;
  monthlyLlmTokens?: bigint | null;
  monthlyTtsCharacters?: bigint | null;
  monthlyNlpTextUnits?: bigint | null;
  monthlyEmbeddingTokens?: bigint | null;
}

/** The override row additionally carries the tenant-set spend ceiling (D12). */
export interface BillingOverrideColumns extends BillingAllowanceColumns {
  monthlySpendLimitMicros?: bigint | null;
}

export interface ResolvedBillingAllowances {
  /** False for a null-plan (ungated-legacy) tenant — nothing is gated or billed as overage. */
  gated: boolean;
  /** Pooled per-capability allowance in that capability's billing units; null = unlimited. */
  allowances: Record<AiCapability, Decimal | null>;
  /** Tenant-set monthly spend ceiling in integer micros; null = none (the default). */
  spendLimitMicros: bigint | null;
}

const ALLOWANCE_COLUMN_OF: Record<AiCapability, keyof BillingAllowanceColumns> = {
  [AiCapability.STT]: 'monthlySttSessionSeconds',
  [AiCapability.LLM]: 'monthlyLlmTokens',
  [AiCapability.TTS]: 'monthlyTtsCharacters',
  [AiCapability.NLP]: 'monthlyNlpTextUnits',
  [AiCapability.EMBEDDING]: 'monthlyEmbeddingTokens',
};

/** Non-null override wins; null/undefined inherits (resolve-entitlements `pick`). */
function pick(override: bigint | null | undefined, base: bigint | null | undefined): bigint | null {
  const value = override ?? base;
  return value ?? null;
}

export function resolveBillingAllowances(
  plan: TenantPlan | null | undefined,
  planRow: BillingAllowanceColumns | null | undefined,
  override: BillingOverrideColumns | null | undefined,
): ResolvedBillingAllowances {
  const unlimited = Object.fromEntries(Object.values(AiCapability).map((capability) => [capability, null])) as Record<AiCapability, Decimal | null>;

  // Q3 — a null-plan tenant is ungated-legacy; overrides are intentionally
  // ignored, mirroring `resolveEntitlements`.
  if (plan === null || plan === undefined) {
    return { gated: false, allowances: unlimited, spendLimitMicros: null };
  }

  const allowances = { ...unlimited };
  for (const capability of Object.values(AiCapability)) {
    const column = ALLOWANCE_COLUMN_OF[capability];
    const resolved = pick(override?.[column], planRow?.[column]);
    allowances[capability] = resolved === null ? null : new Decimal(resolved.toString());
  }

  return {
    gated: true,
    allowances,
    spendLimitMicros: override?.monthlySpendLimitMicros ?? null,
  };
}
