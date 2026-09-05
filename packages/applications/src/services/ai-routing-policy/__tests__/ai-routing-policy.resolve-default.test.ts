/**
 * TASK-862 — `AiRoutingPolicyService.resolveDefault`, the one "default model
 * for non-agent task X" resolution `AiTaskDefaultService` now fronts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { AiRoutingPolicyFactory, AiRoutingPolicyStatus, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';
import { TaskSelectionVetoedError } from '../task-selection-veto';

const TENANT = 'tenant-abc';

function row(over: Record<string, any> = {}) {
  const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: over.tenantId ?? SYSTEM_TENANT_ID,
    taskKey: over.taskKey ?? 'guardrail.validate',
    modelId: over.modelId ?? 'model-1',
    isDefault: over.isDefault ?? true,
    enabled: over.enabled ?? true,
    priority: over.priority ?? 0,
    status: over.status ?? AiRoutingPolicyStatus.ACTIVE,
  });
  if (over.resourceStatus) {
    // `resourceStatus` is read-only on the entity by design — soft-delete and
    // restore are repository operations, and the factory does not forward it.
    // A test that needs a PARKED row therefore seeds the backing field.
    (entity as unknown as { _resourceStatus: ResourceStatusType })._resourceStatus = over.resourceStatus;
  }
  return entity;
}

/** True when a row is LIVE, mirroring the repository's default filter. */
function isLive(r: any): boolean {
  return r.resourceStatus === ResourceStatusType.ENABLED && r.enabled === true;
}

function makeService(opts: { rows?: any[]; models?: Record<string, any>; roles?: string[]; clsTenantId?: string } = {}) {
  const rows = opts.rows ?? [];
  const repo = {
    // Mirrors `AiRoutingPolicyRepository.findCandidates`: ACTIVE by default,
    // and LIVE-only unless the caller asks for parked rows as well.
    findCandidates: vi.fn(async (tenantIds: string[], taskKey: string, _tx?: unknown, options: { includeParked?: boolean } = {}) =>
      rows
        .filter((r) => tenantIds.includes(r.tenantId) && r.taskKey === taskKey && r.status === AiRoutingPolicyStatus.ACTIVE)
        .filter((r) => options.includeParked === true || isLive(r)),
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

/**
 * TASK-872 — the THREE-STATE rule, applied to the routing plane.
 *
 * `AiProviderConnection` states it and `apps/guardrail` already implements it
 * (`TenantSelectionVetoedError`): absent = no opinion, so SYSTEM applies;
 * enabled = the tenant's row wins; DISABLED = a VETO, and the resolver fails
 * closed rather than folding through to SYSTEM.
 *
 * `resolveDefault` used to get the third state wrong in the quietest possible
 * way. `findCandidates` hard-filtered parked rows out, so a tenant that had
 * switched its OWN elected configuration off read as an EMPTY tenant tier —
 * indistinguishable from "never configured" — and the resolver widened to
 * SYSTEM with `source: 'system'`. The tenant got the platform's model for a
 * selection it had explicitly disabled.
 */
describe('AiRoutingPolicyService.resolveDefault — the tenant VETO (three-state parity)', () => {
  it('a DISABLED elected tenant row is a VETO: it raises and never widens to SYSTEM', async () => {
    const parked = row({ tenantId: TENANT, isDefault: true, resourceStatus: ResourceStatusType.DISABLED });
    const { svc } = makeService({ rows: [row({ tenantId: SYSTEM_TENANT_ID, modelId: 'model-1' }), parked] });

    await expect(svc.resolveDefault(TENANT, 'guardrail.validate')).rejects.toBeInstanceOf(TaskSelectionVetoedError);
  });

  it('an elected tenant row with enabled:false is the same VETO', async () => {
    const parked = row({ tenantId: TENANT, isDefault: true, enabled: false });
    const { svc } = makeService({ rows: [row({ tenantId: SYSTEM_TENANT_ID }), parked] });

    await expect(svc.resolveDefault(TENANT, 'guardrail.validate')).rejects.toBeInstanceOf(TaskSelectionVetoedError);
  });

  it('names the tenant and the task key, so the refusal is actionable', async () => {
    const { svc } = makeService({ rows: [row({ tenantId: TENANT, isDefault: true, enabled: false })] });

    await expect(svc.resolveDefault(TENANT, 'guardrail.validate')).rejects.toMatchObject({
      tenantId: TENANT,
      taskKey: 'guardrail.validate',
    });
  });

  it('an ABSENT tenant row still widens to SYSTEM — absence is not a veto', async () => {
    const sys = row({ tenantId: SYSTEM_TENANT_ID });
    const { svc } = makeService({ rows: [sys] });

    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('system');
    expect(r.policy?.id).toBe(sys.id);
  });

  it('an ENABLED tenant row still wins', async () => {
    const own = row({ tenantId: TENANT });
    const { svc } = makeService({ rows: [row({ tenantId: SYSTEM_TENANT_ID }), own] });

    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('tenant');
    expect(r.policy?.id).toBe(own.id);
  });

  it('a parked row the tenant never ELECTED is not a veto — only the election speaks', async () => {
    // A candidate someone parked while authoring says nothing about the
    // selection; the tenant has expressed no opinion, so SYSTEM applies.
    const sys = row({ tenantId: SYSTEM_TENANT_ID });
    const { svc } = makeService({ rows: [sys, row({ tenantId: TENANT, isDefault: false, enabled: false })] });

    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('system');
    expect(r.policy?.id).toBe(sys.id);
  });

  it('a LIVE tenant row alongside a parked sibling still wins — the veto is only about an empty live tier', async () => {
    const live = row({ tenantId: TENANT, isDefault: true });
    const { svc } = makeService({ rows: [live, row({ tenantId: TENANT, isDefault: false, enabled: false })] });

    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBe('tenant');
    expect(r.policy?.id).toBe(live.id);
  });

  it('a parked SYSTEM row is ABSENCE, not a veto — there is no tier left to widen to', async () => {
    // SYSTEM is the last tier: a caller reading `source: null` already fails
    // closed, and raising here would turn every unconfigured platform task into
    // a different error for the same condition.
    const { svc } = makeService({ rows: [row({ tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.DISABLED })] });

    const r = await svc.resolveDefault(TENANT, 'guardrail.validate');
    expect(r.source).toBeNull();
    expect(r.policy).toBeNull();
  });

  it('systemOnly never vetoes: the tenant tier is not consulted at all', async () => {
    const { svc } = makeService({ rows: [row({ tenantId: TENANT, taskKey: 'nlp.ner', enabled: false }), row({ taskKey: 'nlp.ner' })] });

    const r = await svc.resolveDefault(TENANT, 'nlp.ner', { systemOnly: true });
    expect(r.source).toBe('system');
  });

  it('noWiden vetoes too — the tenant tier IS the answer there', async () => {
    const { svc } = makeService({ rows: [row({ tenantId: TENANT, isDefault: true, enabled: false })] });

    await expect(svc.resolveDefault(TENANT, 'guardrail.validate', { noWiden: true })).rejects.toBeInstanceOf(TaskSelectionVetoedError);
  });
});
