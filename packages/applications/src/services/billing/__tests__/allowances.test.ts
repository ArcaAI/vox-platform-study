import { describe, expect, it } from 'vitest';
import { AiCapability, TenantPlan } from '@arcaai/domains';

import { resolveBillingAllowances } from '../allowances';

/**
 * Pure allowance resolution for the invoice engine.
 *
 * The chain is `PlanEntitlement` row ← `TenantEntitlement` override (a non-null
 * override field wins; null inherits), matching `resolve-entitlements.ts`
 * precedence for the columns it covers. The invoice engine resolves the FIVE
 * per-capability allowance columns (D11) plus the tenant spend limit (D12) —
 * columns the entitlements resolver does not surface yet ('s lane; this
 * function reads the same two rows, so the two converge by construction).
 *
 * `null` everywhere means UNLIMITED — no overage line can ever fall out of it.
 */
describe('resolveBillingAllowances', () => {
  it('resolves plan-row allowances when no override exists', () => {
    const resolved = resolveBillingAllowances(TenantPlan.PRO, { monthlyLlmTokens: 5_000_000n, monthlyTtsCharacters: 200_000n }, null);
    expect(resolved.gated).toBe(true);
    expect(resolved.allowances[AiCapability.LLM]?.toNumber()).toBe(5_000_000);
    expect(resolved.allowances[AiCapability.TTS]?.toNumber()).toBe(200_000);
    // Unset plan columns = unlimited.
    expect(resolved.allowances[AiCapability.STT]).toBeNull();
    expect(resolved.allowances[AiCapability.NLP]).toBeNull();
    expect(resolved.allowances[AiCapability.EMBEDDING]).toBeNull();
    expect(resolved.spendLimitMicros).toBeNull();
  });

  it('lets a non-null tenant override beat the plan row; null override inherits', () => {
    const resolved = resolveBillingAllowances(
      TenantPlan.STARTER,
      { monthlyLlmTokens: 1_000_000n, monthlySttSessionSeconds: 36_000n },
      { monthlyLlmTokens: 9_000_000n, monthlySttSessionSeconds: null, monthlySpendLimitMicros: 250_000_000n },
    );
    expect(resolved.allowances[AiCapability.LLM]?.toNumber()).toBe(9_000_000); // override wins
    expect(resolved.allowances[AiCapability.STT]?.toNumber()).toBe(36_000); // null override inherits
    expect(resolved.spendLimitMicros).toBe(250_000_000n);
  });

  it('a null plan (ungated-legacy tenant, Q3) resolves everything unlimited', () => {
    const resolved = resolveBillingAllowances(null, { monthlyLlmTokens: 1n }, { monthlyLlmTokens: 2n });
    expect(resolved.gated).toBe(false);
    for (const capability of Object.values(AiCapability)) {
      expect(resolved.allowances[capability]).toBeNull();
    }
    expect(resolved.spendLimitMicros).toBeNull();
  });

  it('tolerates missing rows entirely (fresh tenant, unseeded plan matrix)', () => {
    const resolved = resolveBillingAllowances(TenantPlan.ENTERPRISE, null, null);
    expect(resolved.gated).toBe(true);
    expect(resolved.allowances[AiCapability.LLM]).toBeNull();
  });
});
