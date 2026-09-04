/**
 * TASK-862 — `AiRoutingPolicyService.resolveDefault`, the one "default model
 * for non-agent task X" resolution `AiTaskDefaultService` now fronts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { AiRoutingPolicyFactory, AiRoutingPolicyStatus, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';

const TENANT = 'tenant-abc';

function row(over: Record<string, any> = {}) {
  return AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: over.tenantId ?? SYSTEM_TENANT_ID,
    taskKey: over.taskKey ?? 'guardrail.validate',
    modelId: over.modelId ?? 'model-1',
    isDefault: over.isDefault ?? true,
    enabled: over.enabled ?? true,
    priority: over.priority ?? 0,
    status: over.status ?? AiRoutingPolicyStatus.ACTIVE,
  });
}

function makeService(opts: { rows?: any[]; models?: Record<string, any>; roles?: string[]; clsTenantId?: string } = {}) {
  const rows = opts.rows ?? [];
  const repo = {
    findCandidates: vi.fn(async (tenantIds: string[], taskKey: string) =>
      rows.filter((r) => tenantIds.includes(r.tenantId) && r.taskKey === taskKey && r.status === AiRoutingPolicyStatus.ACTIVE && r.enabled),
    ),
  };
  const models = opts.models ?? { 'model-1': { id: 'model-1', slug: 'granite', resourceStatus: ResourceStatusType.ENABLED } };
  const modelRepo = {
    findById: vi.fn(async (id: string) => {
      if (!models[id]) throw new Error('not found');
      return models[id];
    }),
  };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? (opts.clsTenantId ?? TENANT) : undefined)) };
  const db = { baseClient: { $lane: 'base' } };
  const svc = new AiRoutingPolicyService(repo as any, {} as any, modelRepo as any, {} as any, db as any, {} as any, { emit: vi.fn() } as any, cls as any);
  return { svc, repo, modelRepo };
}

describe('AiRoutingPolicyService.resolveDefault', () => {
  it("returns the tenant's elected default (source tenant) and its ENABLED model, never consulting SYSTEM's row", async () => {
    const own = row({ tenantId: TENANT, modelId: 'model-1' });
    const { svc } = makeService({ rows: [row({ tenantId: SYSTEM_TENANT_ID, modelId: 'model-sys' }), own], models: { 'model-1': { id: 'model-1', slug: 'own', resourceStatus: 'ENABLED' } } });
    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('tenant');
    expect(r.policy?.id).toBe(own.id);
    expect(r.model?.slug).toBe('own');
  });

  it('widens to the SYSTEM elected default only on ABSENCE (source system)', async () => {
    const sys = row();
    const { svc, repo } = makeService({ rows: [sys] });
    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('system');
    expect(r.policy?.id).toBe(sys.id);
    // Exactly the two ids — the Global customer tenant can never enter.
    expect(repo.findCandidates.mock.calls[0][0]).toEqual([TENANT, SYSTEM_TENANT_ID]);
  });

  it('reads SYSTEM only for systemOnly (super-admin-only task keys ignore tenant rows)', async () => {
    const { svc, repo } = makeService({ rows: [row({ tenantId: TENANT, taskKey: 'nlp.ner' }), row({ taskKey: 'nlp.ner' })] });
    const r = await svc.resolveDefault(TENANT, 'nlp.ner', { systemOnly: true });
    expect(r.source).toBe('system');
    expect(repo.findCandidates.mock.calls[0][0]).toEqual([SYSTEM_TENANT_ID]);
  });

  it("reads the tenant's own rows only for noWiden (the raw editable row)", async () => {
    const { svc, repo } = makeService({ rows: [row()] });
    const r = await svc.resolveDefault(TENANT, 'guardrail.validate', { noWiden: true });
    expect(r.source).toBeNull();
    expect(r.policy).toBeNull();
    expect(repo.findCandidates.mock.calls[0][0]).toEqual([TENANT]);
  });

  it('prefers isDefault over ordering, and falls back to the first candidate when none is elected', async () => {
    const first = row({ tenantId: TENANT, isDefault: false, priority: 0 });
    const elected = row({ tenantId: TENANT, isDefault: true, priority: 5 });
    const { svc } = makeService({ rows: [first, elected] });
    expect((await svc.resolveDefault(TENANT, 'guardrail.validate')).policy?.id).toBe(elected.id);

    const only = row({ tenantId: TENANT, isDefault: false });
    const { svc: svc2 } = makeService({ rows: [only] });
    expect((await svc2.resolveDefault(TENANT, 'guardrail.validate')).policy?.id).toBe(only.id);
  });

  it('answers source null / policy null / model null when neither tier has a live configuration', async () => {
    const { svc } = makeService({ rows: [] });
    expect(await svc.resolveDefault(TENANT, 'guardrail.validate')).toEqual({ tenantId: TENANT, taskKey: 'guardrail.validate', source: null, policy: null, model: null });
  });

  it('a DISABLED or unreadable catalogue model is "no model" (the caller fails closed), never a throw', async () => {
    const { svc } = makeService({ rows: [row({ modelId: 'gone' })], models: {} });
    expect((await svc.resolveDefault(TENANT, 'guardrail.validate')).model).toBeNull();
    const { svc: svc2 } = makeService({ rows: [row()], models: { 'model-1': { id: 'model-1', slug: 'x', resourceStatus: 'DISABLED' } } });
    expect((await svc2.resolveDefault(TENANT, 'guardrail.validate')).model).toBeNull();
  });

  it('rejects an unknown task key', async () => {
    const { svc } = makeService();
    await expect(svc.resolveDefault(TENANT, 'not.a.key')).rejects.toThrow(/Unknown AI task key/);
  });
});
