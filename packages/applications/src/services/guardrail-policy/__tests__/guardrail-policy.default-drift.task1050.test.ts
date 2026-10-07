/**
 * TASK-1050 W2h round 3 (README §11.3 C, "default changed since your edit"):
 *
 *   - `GET admin/guardrail/judge-models/:modelId/judge-meta` reads `{ modelId, slug, version, judge, judgeDefaults,
 *     isDefault, defaultChangedSinceEdit }` — platform admin, tenant-less; 404 for a model without `_metadata.judge`.
 *   - Every new revision stores the default it was made against in `_metadata.defaultAtEdit`.
 *   - `defaultChangedSinceEdit` (policy-key entries AND judge meta) is true when the current value differs from the
 *     default AND the default differs from the one captured at the last edit (or restore). Legacy revisions, which
 *     captured nothing, report false.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const revisionSeq = vi.hoisted(() => ({ n: 0 }));
vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    GuardrailPolicyRevisionFactory: {
      CreateGuardrailPolicyRevision: (props: Record<string, unknown>) => {
        revisionSeq.n += 1;
        return { id: `rev-${revisionSeq.n}`, at: new Date(Date.UTC(2026, 9, 7, 0, revisionSeq.n)), restoredFromRevisionId: null, ...props };
      },
    },
  };
});

import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { GuardrailPolicyService } from '../guardrail-policy.service';
import { parseGuardrailPolicyKeyCatalogue } from '../policy-key-catalogue';
import { realCatalogue } from './real-catalogue';

const GRANITE = 'model-granite';
const QWEN = 'model-qwen';
const GLIGUARD = 'model-gliguard';

const tiers = (controversial: string) => ({ Safe: 'pass', Controversial: controversial, Unsafe: 'flag' });
const QWEN_JUDGE = {
  protocol: 'qwen3guard_native',
  lanes: ['injection_judge', 'unsafe_content_judge'],
  categoryMap: { Jailbreak: { lane: 'injection_judge', category: 'instruction_override' }, Violent: { lane: 'unsafe_content_judge', category: 'violence' } },
  tiers: tiers('warn'),
};

function makeService(opts: { roles?: string[]; clsTenantId?: string | null } = {}) {
  const store: Record<string, any> = {
    [GRANITE]: {
      id: GRANITE,
      slug: 'granite',
      tenantId: SYSTEM_TENANT_ID,
      version: 7,
      metaData: { judge: { protocol: 'criteria_json', lanes: ['medical_validation'] }, policy: { judgeTemperature: 0.05 }, policyDefaults: { judgeTemperature: 0.05 } },
    },
    [QWEN]: { id: QWEN, slug: 'qwen3guard-gen-0.6b', tenantId: SYSTEM_TENANT_ID, version: 3, metaData: { judge: structuredClone(QWEN_JUDGE), judgeDefaults: structuredClone(QWEN_JUDGE) } },
    [GLIGUARD]: { id: GLIGUARD, slug: 'gliguard', tenantId: SYSTEM_TENANT_ID, version: 2, metaData: { policy: {} } },
  };
  const aiModels = {
    findByIdOrNull: vi.fn(async (id: string) => (store[id] ? { ...store[id], metaData: structuredClone(store[id].metaData) } : null)),
    findAll: vi.fn(async () => Object.values(store)),
    updateWithVersion: vi.fn(async (id: string, entity: any) => {
      store[id] = { ...entity, version: store[id].version + 1 };
      return store[id];
    }),
  };
  const revisionRows: any[] = [];
  const revisions = {
    create: vi.fn(async (entity: any) => {
      revisionRows.unshift(entity);
      return entity;
    }),
    findLatestByKey: vi.fn(async (aiModelId: string, key: string) => revisionRows.find((r) => r.aiModelId === aiModelId && r.policyKey === key) ?? null),
    listByKey: vi.fn(async (aiModelId: string, key: string, limit = 50) => revisionRows.filter((r) => r.aiModelId === aiModelId && r.policyKey === key).slice(0, limit)),
    findById: vi.fn(async () => {
      throw new Error('nf');
    }),
  };
  const routing = {
    resolveDefault: vi.fn(async (_t: string, taskKey: string) => {
      const id = taskKey === 'guardrail.validate' ? GRANITE : taskKey === 'guardrail.safety' ? GLIGUARD : null;
      return { taskKey, source: id ? 'system' : null, policy: id ? { id: `p-${taskKey}`, modelId: id } : null, model: id ? store[id] : null };
    }),
  };
  const roles = opts.roles ?? ['SUPER_ADMIN'];
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'admin-1', roles } : k === 'tenantId' ? (opts.clsTenantId ?? null) : undefined)) };
  const service = new GuardrailPolicyService(
    aiModels as any,
    revisions as any,
    routing as any,
    { runInTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work({})) } as any,
    { available: true, source: 'real', ...parseGuardrailPolicyKeyCatalogue(realCatalogue) } as any,
    { emit: vi.fn() } as any,
    cls as any,
    { publish: vi.fn(async () => undefined) } as any,
    undefined,
    undefined,
  );
  return { service, store, revisions, revisionRows, aiModels };
}

const entry = async (service: GuardrailPolicyService, key: string) =>
  (await service.listPolicyKeys()).groups.flatMap((g) => g.keys).find((k) => k.key === key)!;

beforeEach(() => {
  revisionSeq.n = 0;
});

describe('GET judge-models/:modelId/judge-meta', () => {
  it('reads the declaration, the defaults and the row version', async () => {
    const { service } = makeService();
    expect(await service.getJudgeMeta(QWEN)).toEqual({
      modelId: QWEN,
      slug: 'qwen3guard-gen-0.6b',
      version: 3,
      judge: QWEN_JUDGE,
      judgeDefaults: QWEN_JUDGE,
      isDefault: true,
      defaultChangedSinceEdit: false,
    });
  });

  it('a model without _metadata.judge is 404, and so is an unknown one', async () => {
    const { service } = makeService();
    await expect(service.getJudgeMeta(GLIGUARD)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getJudgeMeta('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is platform-admin only (tenant admin, or a super admin with a customer working tenant: 403)', async () => {
    await expect(makeService({ roles: ['TENANT_ADMIN'] }).service.getJudgeMeta(QWEN)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService({ clsTenantId: 'aaaaaaaa-0000-0000-0000-000000000001' }).service.getJudgeMeta(QWEN)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('revisions capture the default they were made against', () => {
  it('stores `_metadata.defaultAtEdit` on an edit, a reset and a judge edit', async () => {
    const { service, revisions } = makeService();
    await service.updatePolicyKey('judgeTemperature', { value: 0.3, expectedVersion: 7 });
    expect(revisions.create).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'edit', metaData: { defaultAtEdit: 0.05 } }), expect.anything());
    await service.resetPolicyKey('judgeTemperature');
    expect(revisions.create).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'reset', metaData: { defaultAtEdit: 0.05 } }), expect.anything());
    await service.updateJudgeMeta(QWEN, { tiers: tiers('block'), expectedVersion: 3 });
    expect(revisions.create).toHaveBeenLastCalledWith(expect.objectContaining({ policyKey: 'judge', metaData: { defaultAtEdit: QWEN_JUDGE } }), expect.anything());
  });

  it('captures `null` when the key had no default at the time', async () => {
    const { service, revisions } = makeService();
    await service.updatePolicyKey('judgeMaxTokens', { value: 200, expectedVersion: 7 });
    expect(revisions.create).toHaveBeenLastCalledWith(expect.objectContaining({ metaData: { defaultAtEdit: null } }), expect.anything());
  });
});

describe('defaultChangedSinceEdit — policy-key entries', () => {
  it('false right after an edit; true once the seed moves the default under an edited value', async () => {
    const { service, store } = makeService();
    await service.updatePolicyKey('judgeTemperature', { value: 0.3, expectedVersion: 7 });
    expect(await entry(service, 'judgeTemperature')).toMatchObject({ isDefault: false, defaultChangedSinceEdit: false });

    store[GRANITE].metaData.policyDefaults.judgeTemperature = 0.1; // a seed upgrade
    expect(await entry(service, 'judgeTemperature')).toMatchObject({ currentValue: 0.3, defaultValue: 0.1, defaultChangedSinceEdit: true });
    expect((await service.getPolicyKey('judgeTemperature')).defaultChangedSinceEdit).toBe(true);
  });

  it('false when the current value equals the (new) default', async () => {
    const { service, store } = makeService();
    await service.updatePolicyKey('judgeTemperature', { value: 0.3, expectedVersion: 7 });
    store[GRANITE].metaData.policyDefaults.judgeTemperature = 0.3;
    expect((await entry(service, 'judgeTemperature')).defaultChangedSinceEdit).toBe(false);
  });

  it('reads the LAST edit: a later edit against the new default clears the flag', async () => {
    const { service, store } = makeService();
    await service.updatePolicyKey('judgeTemperature', { value: 0.3, expectedVersion: 7 });
    store[GRANITE].metaData.policyDefaults.judgeTemperature = 0.1;
    await service.updatePolicyKey('judgeTemperature', { value: 0.4, expectedVersion: 8 });
    expect((await entry(service, 'judgeTemperature')).defaultChangedSinceEdit).toBe(false);
  });

  it('a legacy revision (no defaultAtEdit) reports false; no revision at all reports false', async () => {
    const { service, store, revisionRows } = makeService();
    store[GRANITE].metaData.policy.judgeTemperature = 0.9;
    expect((await entry(service, 'judgeTemperature')).defaultChangedSinceEdit).toBe(false);
    revisionRows.push({ id: 'legacy', aiModelId: GRANITE, policyKey: 'judgeTemperature', value: 0.9, reason: 'edit', actorId: 'a', valueHash: 'h', at: new Date() });
    expect((await entry(service, 'judgeTemperature')).defaultChangedSinceEdit).toBe(false);
  });

  it('every entry carries the flag', async () => {
    const { service } = makeService();
    const keys = (await service.listPolicyKeys()).groups.flatMap((g) => g.keys);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k.defaultChangedSinceEdit === 'boolean')).toBe(true);
  });
});

describe('defaultChangedSinceEdit — judge meta', () => {
  it('true when the seed moves judgeDefaults under an edited mapping; on the write response and the read', async () => {
    const { service, store } = makeService();
    const written = await service.updateJudgeMeta(QWEN, { tiers: tiers('block'), expectedVersion: 3 });
    expect(written).toMatchObject({ isDefault: false, defaultChangedSinceEdit: false, changed: true });
    store[QWEN].metaData.judgeDefaults = { ...QWEN_JUDGE, tiers: tiers('pass') };
    expect(await service.getJudgeMeta(QWEN)).toMatchObject({ isDefault: false, defaultChangedSinceEdit: true });
  });

  it('a reset back to the default clears it', async () => {
    const { service, store } = makeService();
    await service.updateJudgeMeta(QWEN, { tiers: tiers('block'), expectedVersion: 3 });
    store[QWEN].metaData.judgeDefaults = { ...QWEN_JUDGE, tiers: tiers('pass') };
    expect(await service.resetJudgeMeta(QWEN)).toMatchObject({ isDefault: true, defaultChangedSinceEdit: false });
  });
});
