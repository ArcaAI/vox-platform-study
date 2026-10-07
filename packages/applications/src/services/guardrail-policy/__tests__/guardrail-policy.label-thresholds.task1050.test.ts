/**
 * TASK-1050 W2h round 2 — classifier thresholds inside `_metadata.labelTaxonomy` are platform-admin hyper-parameters
 * on the policy-keys surface: the top-level `threshold` and each task's `cls_threshold`, on the guardrail.safety,
 * guardrail.injection, guardrail.pii and guardrail.pii.spans rows. Bounds [0, 1]; If-Match on the model row; a
 * revision per write (`labelTaxonomy.threshold` / `labelTaxonomy.tasks.<task>.cls_threshold`); reset from
 * `_metadata.labelTaxonomyDefaults` (absent → the current value is the default, reported as such); the invalidation
 * publish. Labels, the task set and benign labels stay NOT editable. And the medical-judge capability rule on the
 * judge-lanes route: a model that declares a judge WITHOUT `medical_validation` is refused; a legacy row is allowed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const revisionSeq = vi.hoisted(() => ({ n: 0 }));
vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    GuardrailPolicyRevisionFactory: {
      CreateGuardrailPolicyRevision: (props: Record<string, unknown>) => {
        revisionSeq.n += 1;
        return { id: `rev-${revisionSeq.n}`, at: new Date('2026-10-07T00:00:00Z'), restoredFromRevisionId: null, ...props };
      },
    },
  };
});

import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { GuardrailPolicyService } from '../guardrail-policy.service';
import { parseGuardrailPolicyKeyCatalogue } from '../policy-key-catalogue';
import { realCatalogue } from './real-catalogue';

const GLIGUARD = 'model-gliguard';
const PG2 = 'model-pg2';
const PII = 'model-pii';
const GRANITE = 'model-granite';
const QWEN = 'model-qwen';
const LEGACY = 'model-legacy-guardian';

const QWEN_JUDGE = {
  protocol: 'qwen3guard_native',
  lanes: ['injection_judge', 'unsafe_content_judge'],
  categoryMap: { Jailbreak: { lane: 'injection_judge', category: 'instruction_override' }, Violent: { lane: 'unsafe_content_judge', category: 'violence' } },
  tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' },
};

function rows(): Record<string, any> {
  const model = (id: string, slug: string, metaData: Record<string, unknown>, version: number, taskType = 'TEXT_CLASSIFICATION') => ({
    id,
    slug,
    name: slug,
    tenantId: SYSTEM_TENANT_ID,
    version,
    taskType,
    metaData,
  });
  return {
    [GLIGUARD]: model(
      GLIGUARD,
      'gliguard',
      {
        policy: {},
        labelTaxonomy: {
          threshold: 0.4,
          benignLabels: ['benign', 'safe'],
          tasks: { prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false } },
        },
        labelTaxonomyDefaults: { threshold: 0.4 },
      },
      5,
    ),
    [PG2]: model(
      PG2,
      'llama-prompt-guard-2-86m',
      {
        labelTaxonomy: {
          threshold: 0.5,
          benignLabels: ['BENIGN'],
          tasks: { jailbreak_detection: { labels: ['BENIGN', 'MALICIOUS'], multi_label: false, cls_threshold: 0.5, benign_labels: ['BENIGN'] } },
        },
      },
      2,
    ),
    [PII]: model(PII, 'gliner2-privacy-filter', { labelTaxonomy: { threshold: 0.5, labels: ['person', 'email'] } }, 1),
    [GRANITE]: model(GRANITE, 'granite', { judge: { protocol: 'criteria_json', lanes: ['medical_validation', 'injection_judge'] } }, 7, 'GUARDRAIL'),
    [QWEN]: model(QWEN, 'qwen3guard-gen-0.6b', { judge: QWEN_JUDGE }, 3, 'GUARDRAIL'),
    [LEGACY]: model(LEGACY, 'granite-guardian-legacy', {}, 1, 'GUARDRAIL'),
  };
}

const ELECTED: Record<string, string> = {
  'guardrail.safety': GLIGUARD,
  'guardrail.injection': PG2,
  'guardrail.pii': PII,
  'guardrail.validate': GRANITE,
};

function makeService() {
  const store = rows();
  const tx = { tag: 'tx' };
  const aiModels = {
    findByIdOrNull: vi.fn(async (id: string) => (store[id] ? { ...store[id], metaData: structuredClone(store[id].metaData) } : null)),
    findAll: vi.fn(async () => Object.values(store)),
    updateWithVersion: vi.fn(async (id: string, entity: any, expected: number) => {
      if (store[id].version !== expected) throw new OptimisticConcurrencyException('aiModel', id, { expectedVersion: expected, currentVersion: store[id].version });
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
    listByKey: vi.fn(async (aiModelId: string, key: string) => revisionRows.filter((r) => r.aiModelId === aiModelId && r.policyKey === key)),
    findById: vi.fn(async (id: string) => {
      const found = revisionRows.find((r) => r.id === id);
      if (!found) throw new Error('nf');
      return found;
    }),
  };
  const routing = {
    resolveDefault: vi.fn(async (_t: string, taskKey: string) => {
      const id = ELECTED[taskKey];
      return { tenantId: SYSTEM_TENANT_ID, taskKey, source: id ? 'system' : null, policy: id ? { id: `policy-${taskKey}`, modelId: id } : null, model: id ? store[id] : null };
    }),
    create: vi.fn(async (_t: string, dto: any) => ({ id: `new-${dto.taskKey}`, ...dto })),
    activate: vi.fn(async (id: string) => ({ id })),
    setDefault: vi.fn(async (id: string) => ({ id })),
  };
  const redis = { publish: vi.fn(async () => undefined) };
  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : undefined)) };
  const catalogue = { available: true, source: 'real', ...parseGuardrailPolicyKeyCatalogue(realCatalogue) };
  const service = new GuardrailPolicyService(
    aiModels as any,
    revisions as any,
    routing as any,
    { runInTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) } as any,
    catalogue as any,
    emitter as any,
    cls as any,
    redis as any,
    undefined,
    undefined,
  );
  return { service, store, aiModels, revisions, routing, redis, tx };
}

const codeOf = async (promise: Promise<unknown>) => {
  const error: any = await promise.catch((e) => e);
  return { error, code: error?.getResponse?.()?.code ?? error?.code };
};

beforeEach(() => {
  revisionSeq.n = 0;
});

describe('listing — label thresholds join their row`s group', () => {
  it('lists the top-level threshold and every cls_threshold, with the default and where it came from', async () => {
    const { service } = makeService();
    const groups = (await service.listPolicyKeys()).groups;
    const safety = groups.find((g) => g.taskKey === 'guardrail.safety')!;
    expect(safety.keys.find((k) => k.key === 'labelTaxonomy.threshold')).toMatchObject({
      currentValue: 0.4,
      defaultValue: 0.4,
      defaultSource: 'seed',
      min: 0,
      max: 1,
      kind: 'threshold',
      editable: true,
      inPolicyVersion: true,
      modelId: GLIGUARD,
    });
    // A task with no cls_threshold contributes nothing; labels are never listed as keys.
    expect(safety.keys.some((k) => k.key.includes('prompt_safety'))).toBe(false);
    expect(safety.keys.some((k) => /labels|benign/i.test(k.key))).toBe(false);

    const injection = groups.find((g) => g.taskKey === 'guardrail.injection')!;
    expect(injection.keys.map((k) => k.key).sort()).toEqual(['labelTaxonomy.tasks.jailbreak_detection.cls_threshold', 'labelTaxonomy.threshold']);
    // No `labelTaxonomyDefaults` on this row: the current value IS the default, and the entry says so.
    expect(injection.keys.find((k) => k.key === 'labelTaxonomy.threshold')).toMatchObject({ defaultValue: 0.5, defaultSource: 'current', isDefault: true });

    expect(groups.find((g) => g.taskKey === 'guardrail.pii')?.keys.map((k) => k.key)).toEqual(['labelTaxonomy.threshold']);
    // guardrail.pii.spans elects nothing here, so it has no group.
    expect(groups.some((g) => g.taskKey === 'guardrail.pii.spans')).toBe(false);
  });
});

describe('PUT — edit a threshold', () => {
  it('writes labelTaxonomy.threshold, keeps labels / tasks / benignLabels, appends a revision, invalidates', async () => {
    const { service, store, revisions, redis, tx, aiModels } = makeService();
    const response = await service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.6, expectedVersion: 5 }, 'guardrail.safety');
    const taxonomy = store[GLIGUARD].metaData.labelTaxonomy;
    expect(taxonomy.threshold).toBe(0.6);
    expect(taxonomy.benignLabels).toEqual(['benign', 'safe']);
    expect(taxonomy.tasks).toEqual({ prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false } });
    expect(store[GLIGUARD].metaData.labelTaxonomyDefaults).toEqual({ threshold: 0.4 });
    expect(aiModels.updateWithVersion).toHaveBeenCalledWith(GLIGUARD, expect.anything(), 5, tx);
    expect(revisions.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, aiModelId: GLIGUARD, policyKey: 'labelTaxonomy.threshold', value: 0.6, reason: 'edit' }),
      tx,
    );
    expect(redis.publish).toHaveBeenCalledWith('guardrail:config:invalidate', JSON.stringify({ taskKeys: ['guardrail.safety'] }));
    expect(response).toMatchObject({ key: 'labelTaxonomy.threshold', taskKey: 'guardrail.safety', currentValue: 0.6, defaultValue: 0.4, isDefault: false, version: 6, changed: true });
  });

  it('a task cls_threshold loosens or tightens and touches only that task', async () => {
    const { service, store } = makeService();
    await service.updatePolicyKey('labelTaxonomy.tasks.jailbreak_detection.cls_threshold', { value: 0.9, expectedVersion: 2 }, 'guardrail.injection');
    await service.updatePolicyKey('labelTaxonomy.tasks.jailbreak_detection.cls_threshold', { value: 0.1, expectedVersion: 3 }, 'guardrail.injection');
    const task = store[PG2].metaData.labelTaxonomy.tasks.jailbreak_detection;
    expect(task).toEqual({ labels: ['BENIGN', 'MALICIOUS'], multi_label: false, cls_threshold: 0.1, benign_labels: ['BENIGN'] });
    expect(store[PG2].metaData.labelTaxonomy.threshold).toBe(0.5);
  });

  it.each([1.01, -0.01, '0.5', Number.NaN])('refuses %s with 400 GUARDRAIL_POLICY_VALUE_INVALID before reading the row', async (value) => {
    const { service, aiModels } = makeService();
    expect((await codeOf(service.updatePolicyKey('labelTaxonomy.threshold', { value, expectedVersion: 5 }, 'guardrail.safety'))).code).toBe('GUARDRAIL_POLICY_VALUE_INVALID');
    expect(aiModels.updateWithVersion).not.toHaveBeenCalled();
  });

  it('accepts the bounds themselves, 0 and 1', async () => {
    const { service } = makeService();
    await expect(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0, expectedVersion: 5 }, 'guardrail.safety')).resolves.toMatchObject({ currentValue: 0 });
    await expect(service.updatePolicyKey('labelTaxonomy.threshold', { value: 1, expectedVersion: 6 }, 'guardrail.safety')).resolves.toMatchObject({ currentValue: 1 });
  });

  it('is OCC on the model row: a stale version or none is a concurrency error', async () => {
    const { service, aiModels } = makeService();
    await expect(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.6, expectedVersion: 4 }, 'guardrail.safety')).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    await expect(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.6 }, 'guardrail.safety')).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(aiModels.updateWithVersion).not.toHaveBeenCalled();
  });

  it.each([
    'labelTaxonomy.labels',
    'labelTaxonomy.benignLabels',
    'labelTaxonomy.tasks',
    'labelTaxonomy.tasks.prompt_safety.labels',
    'labelTaxonomy.tasks.jailbreak_detection.benign_labels',
    'labelTaxonomy.tasks.jailbreak_detection.multi_label',
  ])('%s is NOT editable (400 GUARDRAIL_POLICY_KEY_NOT_EDITABLE)', async (key) => {
    const { service, aiModels } = makeService();
    const { error, code } = await codeOf(service.updatePolicyKey(key, { value: ['x'], expectedVersion: 2 }, 'guardrail.injection'));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(code).toBe('GUARDRAIL_POLICY_KEY_NOT_EDITABLE');
    expect(aiModels.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a label threshold needs ?taskKey= naming one of the four classifier rows', async () => {
    const { service } = makeService();
    expect((await codeOf(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.5, expectedVersion: 5 }))).code).toBe('GUARDRAIL_LABEL_THRESHOLD_TASK_KEY_REQUIRED');
    expect((await codeOf(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.5, expectedVersion: 7 }, 'guardrail.validate'))).code).toBe(
      'GUARDRAIL_LABEL_THRESHOLD_TASK_KEY_REQUIRED',
    );
  });

  it('a threshold the row does not carry is 404 (a cls_threshold is only edited where it exists)', async () => {
    const { service } = makeService();
    await expect(service.updatePolicyKey('labelTaxonomy.tasks.prompt_safety.cls_threshold', { value: 0.5, expectedVersion: 5 }, 'guardrail.safety')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a row the task key does not elect is 409 GUARDRAIL_POLICY_MODEL_UNRESOLVED', async () => {
    const { service } = makeService();
    expect((await codeOf(service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.5, expectedVersion: 1 }, 'guardrail.pii.spans'))).code).toBe(
      'GUARDRAIL_POLICY_MODEL_UNRESOLVED',
    );
  });
});

describe('reset, history, restore', () => {
  it('reset copies labelTaxonomyDefaults back as a reset revision and invalidates', async () => {
    const { service, store, revisions, redis } = makeService();
    await service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.7, expectedVersion: 5 }, 'guardrail.safety');
    redis.publish.mockClear();
    const response = await service.resetPolicyKey('labelTaxonomy.threshold', 'guardrail.safety');
    expect(store[GLIGUARD].metaData.labelTaxonomy.threshold).toBe(0.4);
    expect(revisions.create).toHaveBeenLastCalledWith(expect.objectContaining({ policyKey: 'labelTaxonomy.threshold', reason: 'reset', value: 0.4 }), expect.anything());
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ isDefault: true, defaultSource: 'seed', changed: true });
  });

  it('with no seeded default, reset is a no-op on the current value (reported `defaultSource: current`)', async () => {
    const { service, revisions } = makeService();
    const response = await service.resetPolicyKey('labelTaxonomy.threshold', 'guardrail.injection');
    expect(response).toMatchObject({ changed: false, defaultSource: 'current', currentValue: 0.5 });
    expect(revisions.create).not.toHaveBeenCalled();
  });

  it('a lane reset includes the label thresholds of that row', async () => {
    const { service, store } = makeService();
    await service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.9, expectedVersion: 5 }, 'guardrail.safety');
    const response = await service.resetLane('guardrail.safety');
    expect(response.resetKeys).toContain('labelTaxonomy.threshold');
    expect(store[GLIGUARD].metaData.labelTaxonomy.threshold).toBe(0.4);
  });

  it('history lists the threshold`s revisions and restore re-applies one', async () => {
    const { service, store } = makeService();
    const first = await service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.55, expectedVersion: 5 }, 'guardrail.safety');
    await service.updatePolicyKey('labelTaxonomy.threshold', { value: 0.65, expectedVersion: 6 }, 'guardrail.safety');
    const history = await service.listRevisions('labelTaxonomy.threshold', undefined, 'guardrail.safety');
    expect(history.revisions.map((r) => r.value)).toEqual([0.65, 0.55]);
    const restored = await service.restoreRevision('labelTaxonomy.threshold', first.revisionId as string, 'guardrail.safety');
    expect(store[GLIGUARD].metaData.labelTaxonomy.threshold).toBe(0.55);
    expect(restored).toMatchObject({ changed: true, currentValue: 0.55 });
  });
});

describe('the medical-judge capability on the judge-lanes route', () => {
  it('refuses a model that declares a judge WITHOUT medical_validation: 400 JUDGE_LANE_UNSUPPORTED, nothing written', async () => {
    const { service, routing } = makeService();
    const { error, code } = await codeOf(service.updateJudgeLanes({ selections: [{ lane: 'medical_validation', modelId: QWEN }] }));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(code).toBe('JUDGE_LANE_UNSUPPORTED');
    expect(routing.create).not.toHaveBeenCalled();
  });

  it('allows a legacy guardian row with no _metadata.judge, electing it on guardrail.validate', async () => {
    const { service, routing } = makeService();
    await service.updateJudgeLanes({ selections: [{ lane: 'medical_validation', modelId: LEGACY }] });
    expect(routing.create).toHaveBeenCalledWith(SYSTEM_TENANT_ID, expect.objectContaining({ taskKey: 'guardrail.validate', modelId: LEGACY }));
  });

  it('lists the medical lane with declared and legacy candidates, never Qwen', async () => {
    const { service } = makeService();
    const medical = (await service.getJudgeLanes()).lanes.find((l) => l.lane === 'medical_validation')!;
    expect(medical.taskKey).toBe('guardrail.validate');
    expect(medical.candidates.map((c) => c.modelId).sort()).toEqual([GRANITE, LEGACY].sort());
    expect(medical.candidates.find((c) => c.modelId === LEGACY)?.protocol).toBe('undeclared');
  });
});
