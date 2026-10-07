/**
 * TASK-1050 W2h round 2 — `guardrail.validate` (the medical judge) on the routing write path, from ANY caller: a
 * model that declares `_metadata.judge` WITHOUT `medical_validation` (Qwen3Guard-Gen) is 400 JUDGE_LANE_UNSUPPORTED;
 * a model with NO declaration (the legacy criteria_json guardian rows) stays allowed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';
import { assertRoutingModelServesJudgeLane, judgeLaneOfRoutingTaskKey } from '../judge-lane-capability';

const QWEN_JUDGE = {
  protocol: 'qwen3guard_native',
  lanes: ['injection_judge', 'unsafe_content_judge'],
  categoryMap: { Jailbreak: { lane: 'injection_judge', category: 'instruction_override' }, Violent: { lane: 'unsafe_content_judge', category: 'violence' } },
  tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' },
};

function makeService(metaData: Record<string, unknown>) {
  const repo = { findAll: vi.fn().mockResolvedValue([]), create: vi.fn(async (e: any) => e) };
  const models = { findByIdOrNull: vi.fn(async (id: string) => ({ id, slug: id, tenantId: SYSTEM_TENANT_ID, taskType: 'GUARDRAIL', metaData })) };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'] } : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined)) };
  const svc = new AiRoutingPolicyService(
    repo as any,
    {} as any,
    models as any,
    {} as any,
    { baseClient: {} } as any,
    { runInTransaction: vi.fn() } as any,
    { emit: vi.fn() } as any,
    cls as any,
  );
  return { svc, repo };
}

describe('guardrail.validate capability', () => {
  it('maps guardrail.validate to the medical lane', () => {
    expect(judgeLaneOfRoutingTaskKey('guardrail.validate')).toBe('medical_validation');
    expect(judgeLaneOfRoutingTaskKey('guardrail.safety')).toBeNull();
  });

  it('refuses a model that declares a judge without medical_validation (Qwen3Guard) — 400 JUDGE_LANE_UNSUPPORTED', async () => {
    const { svc, repo } = makeService({ judge: QWEN_JUDGE });
    const error: any = await svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.validate', modelId: 'qwen' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: 'JUDGE_LANE_UNSUPPORTED', lane: 'medical_validation', modelId: 'qwen' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('allows a legacy guardian row with no _metadata.judge', async () => {
    const { svc, repo } = makeService({});
    await svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.validate', modelId: 'granite-legacy' } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('allows a model that declares medical_validation', async () => {
    const { svc, repo } = makeService({ judge: { protocol: 'criteria_json', lanes: ['medical_validation', 'injection_judge'] } });
    await svc.create(SYSTEM_TENANT_ID, { taskKey: 'guardrail.validate', modelId: 'granite' } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('a declaration that is present but invalid is refused (it is not "no declaration")', () => {
    expect(() => assertRoutingModelServesJudgeLane('guardrail.validate', { id: 'm', metaData: { judge: { protocol: 'nope', lanes: [] } } })).toThrow(BadRequestException);
  });

  it('the safety-judge keys still need the lane declared: no declaration is refused there', () => {
    expect(() => assertRoutingModelServesJudgeLane('guardrail.judge.injection', { id: 'm', metaData: {} })).toThrow(BadRequestException);
  });
});
