/**
 * TASK-816 Phase 1 (DD-10) — a node's `llmBinding` SELECTS the model; absence changes nothing.
 *
 * ## The hazard this suite exists to hold
 *
 * The live loop resolves its model through `resolveTextSelection(tenantId, 'live')` ->
 * `AiTaskDefault`. On 2026-08-25 an unrelated change removed a credential source and produced a
 * silent, total generation outage. Phase 1 ADDS the successor tier; it removes nothing. So the
 * first `describe` below is the load-bearing one: with no binding, every existing call must be
 * BYTE-IDENTICAL to what it was — same task key, same cascade, same legacy fallback, same throw.
 *
 * ## Why a bound-but-unresolvable slug THROWS
 *
 * Provider/model SELECTION is `failMode: closed` (`09-infrastructure-devops.md` §Configuration
 * Tiers). Falling through to the tenant's `taskKey` default would be exactly the silent
 * substitution that rule forbids: an admin who bound a node to a specific model would keep
 * generating on a different one, with nothing anywhere saying so. An ABSENT binding is a
 * different statement ("I have no opinion") and keeps the fail-open-to-the-task-default path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
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

const aiTaskDefaultService = {
  getEffective: vi.fn(),
  getRow: vi.fn(),
  upsertRow: vi.fn(),
  resolveModelBySlug: vi.fn(),
};

function makeService(): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    undefined,
    aiTaskDefaultService as never,
  );
}

let service: HarnessPolicyService;
beforeEach(() => {
  vi.clearAllMocks();
  service = makeService();
});

describe('TASK-816 — NO binding: every existing resolution path is unchanged', () => {
  it('resolveTextSelection(tenant, "live") still reads the text.live AiTaskDefault', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b' } });

    const result = await service.resolveTextSelection(TENANT, 'live');

    expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.live', TENANT);
    expect(result).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b' });
    // The successor tier must not be consulted when nothing is bound.
    expect(aiTaskDefaultService.resolveModelBySlug).not.toHaveBeenCalled();
  });

  it('an explicitly EMPTY binding option is the same as no option at all', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: { provider: 'ollama', sourceUri: 'granite4:latest' } });

    const result = await service.resolveTextSelection(TENANT, 'finalize', {});

    expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.finalize', TENANT);
    expect(result).toEqual({ provider: 'ollama', model: 'granite4:latest' });
    expect(aiTaskDefaultService.resolveModelBySlug).not.toHaveBeenCalled();
  });

  it('still falls through to the legacy HarnessPolicy cascade when AiTaskDefault resolves nothing', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(
      HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: SYSTEM_TENANT_ID, textProvider: 'lm-studio', textModel: 'legacy-model' }),
    );

    await expect(service.resolveTextSelection(TENANT, 'finalize', {})).resolves.toEqual({ provider: 'lm-studio', model: 'legacy-model' });
  });

  it('still THROWS when neither tier resolves a model', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(null);

    await expect(service.resolveTextSelection(TENANT, 'live', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getEffectivePolicy overlays the taskKey selection exactly as before', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: { provider: 'vllm', sourceUri: 'medgemma' } });
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(null);

    const resp = await service.getEffectivePolicy(TENANT, { taskKey: 'text.live' });

    expect(resp.textProvider).toBe('vllm');
    expect(resp.textModel).toBe('medgemma');
    expect(aiTaskDefaultService.resolveModelBySlug).not.toHaveBeenCalled();
  });
});

describe('TASK-816 — WITH a binding: the node selects, tenant -> SYSTEM', () => {
  it('resolves the bound slug and never consults the taskKey default', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue({ provider: 'vllm', sourceUri: 'medgemma-27b' });

    const result = await service.resolveTextSelection(TENANT, 'finalize', { modelSlug: 'tenant-medgemma' });

    expect(aiTaskDefaultService.resolveModelBySlug).toHaveBeenCalledWith('tenant-medgemma', TENANT);
    expect(result).toEqual({ provider: 'vllm', model: 'medgemma-27b' });
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
    expect(policyRepository.findForExactTenant).not.toHaveBeenCalled();
  });

  it('applies the same `azure -> azure-openai` runtime alias the task tier applies', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue({ provider: 'azure', sourceUri: 'gpt-4o-mini' });

    await expect(service.resolveTextSelection(TENANT, 'live', { modelSlug: 'az-mini' })).resolves.toEqual({
      provider: 'azure-openai',
      model: 'gpt-4o-mini',
    });
  });

  it('FAILS CLOSED when the bound slug resolves to no enabled model — never falls back', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue(null);
    // A perfectly good task default exists; the point is that it must NOT be served.
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b' } });

    await expect(service.resolveTextSelection(TENANT, 'finalize', { modelSlug: 'deleted-slug' })).rejects.toBeInstanceOf(BadRequestException);
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the bound slug lookup throws — a fault is not "no opinion"', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockRejectedValue(new Error('db down'));
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b' } });

    await expect(service.resolveTextSelection(TENANT, 'live', { modelSlug: 'any' })).rejects.toBeInstanceOf(BadRequestException);
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
  });

  it('names the slug in the error, so a misconfigured node is diagnosable', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue(null);
    await expect(service.resolveTextSelection(TENANT, 'finalize', { modelSlug: 'typo-slug' })).rejects.toThrow(/typo-slug/);
  });

  it('getEffectivePolicy honours a node binding passed alongside the taskKey', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue({ provider: 'ollama', sourceUri: 'granite4:latest' });
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(null);

    const resp = await service.getEffectivePolicy(TENANT, { taskKey: 'text.live', modelSlug: 'my-granite' });

    expect(resp.textProvider).toBe('ollama');
    expect(resp.textModel).toBe('granite4:latest');
    // The TEXT task key must not be consulted at all. (`getEffective` IS still called once, for
    // the independent SYSTEM-only `harness.judge` overlay — a different selection entirely.)
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalledWith('text.live', expect.anything());
  });

  it('funding is NEVER stamped here — the binding carries only a slug', async () => {
    aiTaskDefaultService.resolveModelBySlug.mockResolvedValue({ provider: 'vllm', sourceUri: 'medgemma-27b' });
    const result = (await service.resolveTextSelection(TENANT, 'finalize', { modelSlug: 's' })) as Record<string, unknown>;
    // `{provider, model}` and nothing else: funding stays derived downstream from WHOSE
    // `AiProviderConnection` row supplies the credential (`fundingOf`).
    expect(Object.keys(result).sort()).toEqual(['model', 'provider']);
    expect(result.funding).toBeUndefined();
  });
});
