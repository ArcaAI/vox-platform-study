/**
 * `getEffectivePolicy` must honour a task key.
 *
 * The defect: the Python `generate.text` interpreter node validated
 * `config.taskKey`, then resolved its model from the `HarnessPolicy`
 * provider/model columns — never from the `AiTaskDefault` row for that key. The
 * TS-side seam (`resolveTextSelection`) DID consult AiTaskDefault, but
 * `/internal/harness/policy` never called it, so every workflow node resolved
 * the same model regardless of task key and the three seeded rows were inert on
 * the Python path.
 *
 * The fix mirrors the judge overlay already in `getEffectivePolicy`: when the
 * caller supplies a `taskKey`, the AiTaskDefault row for that key (tenant →
 * SYSTEM, resolved by `AiTaskDefaultService.getEffective`) overlays
 * `textProvider`/`textModel` on whichever policy row wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';
import { TaskSelectionVetoedError } from '../../ai-routing-policy/task-selection-veto';

const TENANT = 'tenant-1';

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
  create: vi.fn(async (e: unknown) => e),
  updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
};
const policyChangeRepository = { create: vi.fn(async (e: unknown) => e) };
const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : undefined)) };
const aiTaskDefaultService = { getEffective: vi.fn(), getRow: vi.fn(), upsertRow: vi.fn() };

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

/** SYSTEM row carrying the legacy column values the task key must override. */
function systemRow() {
  return HarnessPolicyFactory.CreateHarnessPolicy({
    tenantId: SYSTEM_TENANT_ID,
    textProvider: 'lm-studio',
    textModel: 'policy-column-model',
  });
}

describe(' D-1 — task-key-driven text selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(systemRow());
    // The judge lookup shares this mock; default it to an unresolved model so
    // only the explicit per-key resolutions below matter.
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });
  });

  it('overlays textProvider/textModel from the AiTaskDefault row for the given taskKey', async () => {
    aiTaskDefaultService.getEffective.mockImplementation(async (key: string) =>
      key === 'text.live' ? { model: { provider: 'azure', sourceUri: 'gpt-4o-live' } } : { model: null },
    );

    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.live' });

    expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.live', TENANT);
    // `azure` normalises to the runtime the text service registers.
    expect(resp.textProvider).toBe('azure-openai');
    expect(resp.textModel).toBe('gpt-4o-live');
  });

  it('resolves a DIFFERENT model for a different taskKey (the defect: all keys resolved the same)', async () => {
    aiTaskDefaultService.getEffective.mockImplementation(async (key: string) => {
      if (key === 'text.live') return { model: { provider: 'lm-studio', sourceUri: 'live-model' } };
      if (key === 'text.finalize') return { model: { provider: 'lm-studio', sourceUri: 'finalize-model' } };
      return { model: null };
    });

    const svc = makeService();
    const live = await svc.getEffectivePolicy(TENANT, { taskKey: 'text.live' });
    const finalize = await svc.getEffectivePolicy(TENANT, { taskKey: 'text.finalize' });

    expect(live.textModel).toBe('live-model');
    expect(finalize.textModel).toBe('finalize-model');
  });

  it('falls back to the policy columns when the taskKey resolves no model', async () => {
    aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });

    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.finalize' });

    expect(resp.textProvider).toBe('lm-studio');
    expect(resp.textModel).toBe('policy-column-model');
  });

  it('is a no-op without a taskKey (byte-identical prior behaviour)', async () => {
    const resp = await makeService().getEffectivePolicy(TENANT);

    expect(resp.textProvider).toBe('lm-studio');
    expect(resp.textModel).toBe('policy-column-model');
  });

  // TASK-872 — the fail-open seam must not swallow a VETO.
  //
  // `resolveTextSelectionForKey` degrades every lookup failure to `null`, and
  // the caller reads `null` as "no opinion, keep the policy columns". For a
  // tenant that DISABLED its own elected routing row that answer is wrong in
  // the dangerous direction: it substitutes the platform's model for the one
  // the tenant refused. A veto is a refusal, so it propagates.
  it('propagates a tenant VETO instead of falling back to the policy columns', async () => {
    aiTaskDefaultService.getEffective.mockImplementation(async (key: string) => {
      if (key === 'text.finalize') throw new TaskSelectionVetoedError(TENANT, 'text.finalize');
      return { model: null };
    });

    await expect(makeService().getEffectivePolicy(TENANT, { taskKey: 'text.finalize' })).rejects.toBeInstanceOf(TaskSelectionVetoedError);
  });

  it('still degrades an ordinary lookup FAILURE to the policy columns', async () => {
    aiTaskDefaultService.getEffective.mockRejectedValue(new Error('control plane unreachable'));

    const resp = await makeService().getEffectivePolicy(TENANT, { taskKey: 'text.finalize' });

    expect(resp.textProvider).toBe('lm-studio');
    expect(resp.textModel).toBe('policy-column-model');
  });
});
