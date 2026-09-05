/**
 * TASK-876 — text selection is AGENT-FIRST, and the old-architecture selection paths are gone.
 *
 * `resolveTextSelection` used to walk three tiers: a node's `llmBinding.modelSlug` (precedence
 * 0), the `text.live` / `text.finalize` `AiTaskDefault` key (precedence 1), and the
 * `HarnessPolicy.textProvider/textModel` columns (precedence 2). All three are removed. The ONE
 * seam now is the tenant's assigned TEXT_GENERATION agent — `department → tenant → SYSTEM`
 * through `TextAgentResolverService` — and it FAILS CLOSED: no assignment anywhere is a
 * configuration error, never a substituted model. `resolveTextFallbackSelection` reads the SAME
 * resolved chain (the tenant's per-agent `autoSwitch` toggle decides whether a fallback runs).
 *
 * Why the SYSTEM assignment is enough as the terminal tier: the seed
 * (`packages/database/src/prisma/db_main/seed/25-agents.ts`) ships a SYSTEM TENANT-scope
 * TEXT_GENERATION assignment (`platform-summarization`), so the deprecated routing-policy read
 * does NOT survive as a fallback here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ProviderVetoedException } from '../../ai-provider-connection/provider-vetoed.exception';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};
const policyChangeRepository = { create: vi.fn(async (entity: unknown) => entity) };
const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
const aiTaskDefaultService = { getEffective: vi.fn(), getRow: vi.fn(), upsertRow: vi.fn(), resolveModelBySlug: vi.fn() };
const textAgents = { resolve: vi.fn() };

const candidate = (over: Record<string, unknown> = {}) => ({
  kind: 'primary',
  agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'tenant' },
  modelSlug: 'lms-gemma-4-e2b-it-qat',
  provider: 'lm-studio',
  model: 'gemma-4-e2b-it-qat',
  resolvedPrompt: null,
  instruction: null,
  parameters: {},
  tools: [],
  fundingTier: 'tenant',
  ...over,
});

const spec = (over: { primary?: Record<string, unknown>; autoSwitch?: boolean; chain?: Record<string, unknown>[] } = {}) => ({
  schemaVersion: 1,
  agent: {},
  primary: candidate(over.primary),
  fallback: {
    autoSwitch: over.autoSwitch ?? true,
    switchAfterConsecutiveFailures: 2,
    chain: over.chain ?? [
      candidate({ kind: 'platform-default', agent: { slug: 'platform-summarization', versionId: 'p1', versionNumber: 1, tenantId: SYSTEM_TENANT_ID, source: 'platform-default' }, fundingTier: 'platform' }),
    ],
  },
});

function makeService(withResolver = true): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    undefined,
    aiTaskDefaultService as never,
    undefined,
    undefined,
    withResolver ? (textAgents as never) : undefined,
  );
}

/** A SYSTEM policy row STILL carrying the legacy columns — they must never select again. */
function systemRow() {
  return HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: SYSTEM_TENANT_ID, textProvider: 'lm-studio', textModel: 'policy-column-model' });
}

beforeEach(() => {
  vi.clearAllMocks();
  policyRepository.findForExactTenant.mockResolvedValue(null);
  policyRepository.findSystemDefault.mockResolvedValue(systemRow());
  aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });
  textAgents.resolve.mockResolvedValue(spec());
});

describe('resolveTextSelection — the assigned TEXT_GENERATION agent is the ONE selection seam', () => {
  it('returns the resolved primary {provider, model} for the caller tenant', async () => {
    await expect(makeService().resolveTextSelection(TENANT, 'live')).resolves.toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat' });
    expect(textAgents.resolve).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it('falls back to the CLS tenant when the caller passes none (the no-arg callers)', async () => {
    await makeService().resolveTextSelection();
    expect(textAgents.resolve).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it('the routing task no longer SELECTS — live, finalize and test resolve the same assigned agent (AgentAssignment has no role dimension)', async () => {
    const svc = makeService();
    const live = await svc.resolveTextSelection(TENANT, 'live');
    const finalize = await svc.resolveTextSelection(TENANT, 'finalize');
    const test = await svc.resolveTextSelection(TENANT, 'test');
    expect(live).toEqual(finalize);
    expect(finalize).toEqual(test);
    // No AiTaskDefault text key is consulted any more (the judge key is a different selection).
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalledWith(expect.stringMatching(/^text\./), expect.anything());
    expect(aiTaskDefaultService.resolveModelBySlug).not.toHaveBeenCalled();
  });

  it('the legacy HarnessPolicy.textProvider/textModel columns are NEVER a selection source', async () => {
    textAgents.resolve.mockRejectedValue(new NotFoundException('No published TEXT_GENERATION agent is assigned for this tenant.'));
    await expect(makeService().resolveTextSelection(TENANT)).rejects.toBeInstanceOf(BadRequestException);
    expect(policyRepository.findForExactTenant).not.toHaveBeenCalled();
    expect(policyRepository.findSystemDefault).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED with an actionable message when no agent is assigned at any tier', async () => {
    textAgents.resolve.mockRejectedValue(new NotFoundException('No published TEXT_GENERATION agent is assigned for this tenant.'));
    await expect(makeService().resolveTextSelection(TENANT)).rejects.toThrow(/TEXT_GENERATION agent/);
  });

  it('FAILS CLOSED when the resolver is not wired — never a silently substituted model', async () => {
    await expect(makeService(false).resolveTextSelection(TENANT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a tenant VETO of the primary provider propagates (a refusal is not "no opinion")', async () => {
    textAgents.resolve.mockRejectedValue(new ProviderVetoedException('llm', 'azure', TENANT));
    await expect(makeService().resolveTextSelection(TENANT)).rejects.toBeInstanceOf(ProviderVetoedException);
  });

  it('returns {provider, model} and nothing else — funding stays derived downstream from the row that serves', async () => {
    const result = (await makeService().resolveTextSelection(TENANT)) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['model', 'provider']);
  });
});

describe('resolveTextFallbackSelection — the resolved chain, gated by the per-agent toggle', () => {
  it('returns the first fallback candidate as {provider, model}', async () => {
    textAgents.resolve.mockResolvedValue(spec({ chain: [candidate({ kind: 'fallback-model', provider: 'azure-openai', model: 'gpt-5.4-mini' }), candidate({ kind: 'platform-default' })] }));
    await expect(makeService().resolveTextFallbackSelection(TENANT, 'finalize')).resolves.toEqual({ provider: 'azure-openai', model: 'gpt-5.4-mini' });
  });

  it('honours autoSwitch:false — the tenant turned HA fallback off for this agent, so no fallback runs', async () => {
    textAgents.resolve.mockResolvedValue(spec({ autoSwitch: false }));
    await expect(makeService().resolveTextFallbackSelection(TENANT, 'live')).resolves.toBeNull();
  });

  it('returns null when the chain is empty (the primary IS the platform default)', async () => {
    textAgents.resolve.mockResolvedValue(spec({ chain: [] }));
    await expect(makeService().resolveTextFallbackSelection(TENANT)).resolves.toBeNull();
  });

  it('stays fail-OPEN by contract: a resolver fault or an un-wired resolver yields null, never a throw', async () => {
    textAgents.resolve.mockRejectedValue(new Error('db down'));
    await expect(makeService().resolveTextFallbackSelection(TENANT)).resolves.toBeNull();
    await expect(makeService(false).resolveTextFallbackSelection(TENANT)).resolves.toBeNull();
    // No text.*.fallback AiTaskDefault key is consulted any more.
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
  });
});

describe('getEffectivePolicy — the assigned-agent overlay is UNCONDITIONAL (the Python lane)', () => {
  it('with a taskKey, textProvider/textModel come from the resolved primary, never from the policy columns', async () => {
    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.live' });
    expect(resp.textProvider).toBe('lm-studio');
    expect(resp.textModel).toBe('gemma-4-e2b-it-qat');
    expect(textAgents.resolve).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it('with a taskKey and NO assigned agent, the columns are NULLED so the Python node degrades `no_text_selection` (fail closed)', async () => {
    textAgents.resolve.mockRejectedValue(new NotFoundException('nothing assigned'));
    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.finalize' });
    expect(resp.textProvider).toBeNull();
    expect(resp.textModel).toBeNull();
  });

  it('a veto propagates through the overlay too', async () => {
    textAgents.resolve.mockRejectedValue(new ProviderVetoedException('llm', 'azure', TENANT));
    await expect(makeService().getEffectivePolicy(TENANT, { taskKey: 'text.finalize' })).rejects.toBeInstanceOf(ProviderVetoedException);
  });

  it('the retired `modelSlug` option (a node`s llmBinding) is INERT — accepted for the wire, consulted by nothing', async () => {
    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.live', modelSlug: 'tenant-medgemma' });
    expect(resp.textModel).toBe('gemma-4-e2b-it-qat');
    expect(aiTaskDefaultService.resolveModelBySlug).not.toHaveBeenCalled();
  });

  // The `AgentAssignment` key has no role dimension, so the task key never gated WHICH agent
  // serves — and the durable lane (`fetch_policy` → `workflows.py`) never sends one. Gating the
  // overlay on it left that lane selecting from the retired `HarnessPolicy` columns.
  it('WITHOUT a taskKey the overlay still applies — the durable workflow never sees the retired columns', async () => {
    const resp = await makeService().getEffectivePolicy(TENANT);
    expect(resp.textProvider).toBe('lm-studio');
    expect(resp.textModel).toBe('gemma-4-e2b-it-qat');
    expect(textAgents.resolve).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it('WITHOUT a taskKey and no agent anywhere, the columns are NULLED (a configuration error, never a silent pass-through)', async () => {
    textAgents.resolve.mockRejectedValue(new NotFoundException('nothing assigned'));
    const resp = await makeService().getEffectivePolicy(TENANT);
    expect(resp.textProvider).toBeNull();
    expect(resp.textModel).toBeNull();
  });

  it('the SYSTEM-default return path is overlaid too (no tenant row of its own)', async () => {
    policyRepository.findForExactTenant.mockResolvedValue(null);
    const resp = await makeService().getEffectivePolicy(TENANT);
    expect(resp.source).toBe('system-default');
    expect(resp.textModel).toBe('gemma-4-e2b-it-qat');
  });
});
