/**
 * TASK-1050 W2h (README §12.2, OD-39) — the four judge-lane routing keys on the routing plane itself.
 *
 *   - `guardrail.judge.{injection,unsafe_content,clinical_safety,leakage}` are routing vocabulary;
 *   - a write binding a model whose `_metadata.judge` does not declare the lane is 400 `JUDGE_LANE_UNSUPPORTED`
 *     from ANY caller of this service (not only `/guardrails/control`);
 *   - the list response marks every `guardrail.*` row `managedBy: 'guardrail-control'`, so `/ai-providers`
 *     renders them read-only with a deep link (one authoritative editor per resource, rule 13).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { AiRoutingPolicyFactory, AiRoutingPolicyStatus, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { GUARDRAIL_JUDGE_TASK_KEYS } from '@arcaai/types';
import { describe, expect, it, vi } from 'vitest';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';
import { AI_TASK_KEYS, AI_TASK_KIND_BY_TASK_KEY, AI_TASK_MODEL_TASK_TYPES, GUARDRAIL_CONTROL_MANAGED_BY, isSuperAdminOnlyTaskKey } from '../constants';

const GRANITE_JUDGE = { protocol: 'criteria_json', lanes: ['medical_validation', 'injection_judge', 'unsafe_content_judge', 'clinical_safety_judge', 'leakage_judge'] };
const QWEN_JUDGE = {
  protocol: 'qwen3guard_native',
  lanes: ['injection_judge', 'unsafe_content_judge'],
  categoryMap: { Jailbreak: { lane: 'injection_judge', category: 'instruction_override' }, Violent: { lane: 'unsafe_content_judge', category: 'violence' } },
  tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' },
};

function row(taskKey: string, id: string) {
  const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: SYSTEM_TENANT_ID,
    taskKey,
    modelId: 'model:x',
    isDefault: true,
    enabled: true,
    policyVersion: 1,
    status: AiRoutingPolicyStatus.DRAFT,
  } as any);
  (entity as any)._id = id;
  return entity;
}

function makeService(opts: { judge?: unknown; taskType?: string; rows?: any[] } = {}) {
  const rows = opts.rows ?? [];
  const repo = {
    findAll: vi.fn().mockResolvedValue(rows),
    findById: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    create: vi.fn(async (entity: any) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: any) => entity),
  };
  const models = {
    findByIdOrNull: vi.fn(async (id: string) => ({
      id,
      slug: id,
      tenantId: SYSTEM_TENANT_ID,
      taskType: opts.taskType ?? 'GUARDRAIL',
      metaData: opts.judge === undefined ? {} : { judge: opts.judge },
    })),
    findById: vi.fn(),
  };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'] } : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined)) };
  const svc = new AiRoutingPolicyService(
    repo as any,
    { findById: vi.fn() } as any,
    models as any,
    { resolveConnection: vi.fn() } as any,
    { baseClient: { aiRoutingPolicy: { findMany: vi.fn().mockResolvedValue(rows) } } } as any,
    { runInTransaction: vi.fn(async (work: any) => work({})) } as any,
    { emit: vi.fn() } as any,
    cls as any,
  );
  return { svc, repo, models };
}

const refusal = async (promise: Promise<unknown>) => {
  const error: any = await promise.catch((e) => e);
  return { error, body: error?.getResponse?.() };
};

describe('the judge-lane routing keys are vocabulary', () => {
  it.each(Object.values(GUARDRAIL_JUDGE_TASK_KEYS))('%s is a known, classified, platform-only key', (key) => {
    expect(AI_TASK_KEYS as readonly string[]).toContain(key);
    expect(AI_TASK_KIND_BY_TASK_KEY[key as keyof typeof AI_TASK_KIND_BY_TASK_KEY]).toBe('CONTENT_SAFETY');
    expect(AI_TASK_MODEL_TASK_TYPES[key as keyof typeof AI_TASK_MODEL_TASK_TYPES]).toEqual(expect.arrayContaining(['GUARDRAIL']));
    expect(isSuperAdminOnlyTaskKey(key)).toBe(true);
  });
});

describe('capability validation on every routing write of a judge-lane key', () => {
  it('create: a model whose judge declaration lacks the lane is 400 JUDGE_LANE_UNSUPPORTED, nothing written', async () => {
    const { svc, repo } = makeService({ judge: QWEN_JUDGE });
    const { error, body } = await refusal(svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.judge.clinical_safety', modelId: 'qwen' } as any));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(body).toMatchObject({ code: 'JUDGE_LANE_UNSUPPORTED', lane: 'clinical_safety_judge' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create: a model with NO judge declaration supports no lane', async () => {
    const { svc } = makeService({});
    const { body } = await refusal(svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.judge.injection', modelId: 'plain' } as any));
    expect(body?.code).toBe('JUDGE_LANE_UNSUPPORTED');
  });

  it('create: an INVALID declaration is refused and its problems are named', async () => {
    const { svc } = makeService({ judge: { protocol: 'qwen3guard_native', lanes: ['injection_judge'] } });
    const { body } = await refusal(svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.judge.injection', modelId: 'broken' } as any));
    expect(body?.code).toBe('JUDGE_LANE_UNSUPPORTED');
    expect(body?.problems.length).toBeGreaterThan(0);
  });

  it('create: a model that declares the lane is accepted', async () => {
    const { svc, repo } = makeService({ judge: QWEN_JUDGE });
    await svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.judge.injection', modelId: 'qwen' } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('update: re-binding a judge-lane row checks the lane too', async () => {
    const existing = row('guardrail.judge.leakage', 'p-leak');
    const { svc } = makeService({ judge: QWEN_JUDGE, rows: [existing] });
    const { body } = await refusal(svc.update('p-leak', SYSTEM_TENANT_ID, { modelId: 'qwen', expectedVersion: 1 } as any));
    expect(body?.code).toBe('JUDGE_LANE_UNSUPPORTED');
  });

  it('other guardrail keys are NOT lane-checked (guardrail.validate binds by task type alone)', async () => {
    const { svc, repo } = makeService({});
    await svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.validate', modelId: 'granite' } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('granite (criteria_json, every lane) serves each judge lane', async () => {
    for (const taskKey of Object.values(GUARDRAIL_JUDGE_TASK_KEYS)) {
      const { svc, repo } = makeService({ judge: GRANITE_JUDGE });
      await svc.create(SYSTEM_TENANT_ID, { taskKey, modelId: 'granite' } as any);
      expect(repo.create).toHaveBeenCalledTimes(1);
    }
  });
});

describe('managedBy — /ai-providers lists guardrail.* rows read-only (OD-39)', () => {
  it('marks guardrail.* rows and only those', async () => {
    const rows = [row('guardrail.judge.injection', 'a'), row('guardrail.validate', 'b'), row('harness.judge', 'c')];
    const { svc } = makeService({ rows });
    const listed = await svc.list(SYSTEM_TENANT_ID);
    const byKey = Object.fromEntries(listed.map((r) => [r.taskKey, r.managedBy]));
    expect(GUARDRAIL_CONTROL_MANAGED_BY).toBe('guardrail-control');
    expect(byKey['guardrail.judge.injection']).toBe('guardrail-control');
    expect(byKey['guardrail.validate']).toBe('guardrail-control');
    expect(byKey['harness.judge']).toBeNull();
  });
});
