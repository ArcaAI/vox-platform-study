/**
 * TASK-890 L11 (§3.13) — the playground proxy RECORDED what a stream spent but
 * never CHECKED whether the tenant was allowed to spend it.
 *
 * Metering without a gate is an invoice, not a limit: a tenant at its
 * `monthlyLlmTokens` ceiling kept generating through this route while the same
 * ceiling stopped it on the summary path. The check belongs in
 * `postTextGenerate` — the ONE place both `generate` and `generate/assembled`
 * reach TEXT — and it must run BEFORE the (billable) upstream call.
 */
import { describe, expect, it, vi } from 'vitest';

import { TextProxyController } from '../text-proxy.controller';

function build(entitlements?: unknown) {
  const post = vi.fn(async () => ({ data: { content: 'hi', usage_detail: null } }));
  const http = { axiosRef: { get: vi.fn(), post } };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };
  const config = { getConfigValue: vi.fn(() => 'http://text') };

  const ctrl = new TextProxyController(
    http as never,
    { fetchByCodeName: vi.fn() } as never,
    cls as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { getObject: vi.fn() } as never,
    config as never,
    undefined, // secretsService
    undefined, // harnessPolicyService
    undefined, // aiModelService
    undefined, // routingPolicies
    undefined, // aiProviderConnectionService
    undefined, // usageLedger
    undefined, // dnaWritingStyleService
    undefined, // effectiveSettingsService
    undefined, // visitTypes
    entitlements as never,
  );
  return { ctrl, post, entitlements: entitlements as { assertMeterQuota: ReturnType<typeof vi.fn> } };
}

describe('TEXT proxy — the LLM allowance is checked before the billable call', () => {
  it('prechecks `monthlyLlmTokens` for the caller tenant, BEFORE posting to TEXT', async () => {
    const entitlements = { assertMeterQuota: vi.fn(async () => undefined) };
    const { ctrl, post } = build(entitlements);

    await ctrl.generate({ prompt: 'summarise' } as never);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('tenant-1', 'monthlyLlmTokens');
    expect(entitlements.assertMeterQuota.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  });

  it('short-circuits an exhausted allowance — TEXT is never called', async () => {
    const entitlements = { assertMeterQuota: vi.fn().mockRejectedValue(new Error('quota exceeded')) };
    const { ctrl, post } = build(entitlements);

    await expect(ctrl.generate({ prompt: 'summarise' } as never)).rejects.toThrow('quota exceeded');
    expect(post).not.toHaveBeenCalled();
  });

  // `generate/assembled` reaches TEXT through the SAME `postTextGenerate`, so
  // the gate above covers it; asserting it separately would only re-test the
  // prompt-assembly fixture.

  it('generates normally when no entitlements service is wired (metering is additive)', async () => {
    const { ctrl, post } = build(undefined);
    await ctrl.generate({ prompt: 'summarise' } as never);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
