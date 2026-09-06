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

/**
 * TASK-890 L14 (§3.14, OD-R) — the playground proxy's ledger rows carry the screening
 * disposition too.
 *
 * The proxy pushes NO opt-out: it applies the tenant's `require_medical` /
 * `include_reasoning` policy and leaves `enabled` absent, so the platform posture governs the
 * call. Its rows therefore say `screened` — or `platform_off` when the platform kill switch is
 * off — and can never say `opted_out`, because no agent, workflow or node opinion reaches this
 * route.
 */
describe('TEXT proxy — the guardrail disposition on the streamed row', () => {
  it('stamps the platform disposition on `generate.stream`', async () => {
    const { EventEmitter } = await import('node:events');
    const upstream = new EventEmitter() as InstanceType<typeof EventEmitter> & { destroy: () => void };
    upstream.destroy = vi.fn();
    const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 1 }) };
    const http = { axiosRef: { get: vi.fn(async () => ({ data: upstream })), post: vi.fn() } };
    const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };

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
      { getConfigValue: vi.fn(() => 'http://text') } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ledger as never,
    );

    const res = new EventEmitter() as never as {
      setHeader: () => void;
      flushHeaders: () => void;
      write: () => void;
      end: () => void;
      status: () => unknown;
      json: () => void;
      writableEnded: boolean;
      headersSent: boolean;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    Object.assign(res, {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn(() => res),
      json: vi.fn(),
      writableEnded: false,
      headersSent: true,
    });

    await ctrl.streamTaskEvents('text-task-1', undefined, res as never);
    const usage = {
      task_id: 'text-task-1',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      endpoint_kind: 'anthropic.messages',
      interrupted: false,
      byok: false,
      prompt_tokens: 10,
      completion_tokens: 5,
    };
    upstream.emit('data', Buffer.from(`event: done\ndata: ${JSON.stringify({ type: 'done', data: { usage } })}\nid: 1-0\n\n`));
    upstream.emit('end');
    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalled());

    const [input] = ledger.recordUsage.mock.calls[0] as [{ common: { attributesJson?: Record<string, unknown> } }];
    expect(input.common.attributesJson).toMatchObject({ guardrail: 'screened' });
  });
});
