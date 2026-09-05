/**
 * AiTaskDefaultService — unit tests for the TASK-862 FACADE.
 *
 * The service no longer owns a table: reads stand on
 * `IAiRoutingPolicyService.resolveDefault`, writes land ONLY on the elected
 * `AiRoutingPolicy` row. Asserted here: the cascade projection, the raw-row
 * projection, upsert validation (task key, slug resolution, taskType), the
 * super-admin / guardrail governance rules, OCC against the ROUTING row's
 * version, and that no `AiTaskDefault` repository exists anywhere in the
 * constructor.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelFactory,
  AiModelFormat,
  AiModelSource,
  AiRoutingPolicyFactory,
  AiRoutingPolicyStatus,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { AiTaskDefaultService } from '../ai-task-default.service';

const TENANT = 'tenant-abc';

function makeModel(overrides: { tenantId?: string; slug?: string; taskType?: ModelTaskType } = {}) {
  return AiModelFactory.CreateAiModel({
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    name: 'Granite Guardian 4.1 8B',
    slug: overrides.slug ?? 'granite-guardian-4.1-8b',
    category: ModelCategory.NLP,
    taskType: overrides.taskType ?? ModelTaskType.GUARDRAIL,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'granite-guardian-4.1-8b',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'granite',
  });
}

function makePolicy(
  overrides: { tenantId?: string; taskKey?: string; modelId?: string; displayName?: string; configJson?: Record<string, unknown> | null; isDefault?: boolean } = {},
) {
  return AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'guardrail.validate',
    modelId: overrides.modelId ?? 'model-1',
    displayName: overrides.displayName ?? null,
    isDefault: overrides.isDefault ?? true,
    enabled: true,
    status: AiRoutingPolicyStatus.ACTIVE,
    configJson: (overrides.configJson ?? null) as any,
  });
}

function makeService(opts: { roles?: string[]; clsTenantId?: string | null } = {}) {
  const modelRepo = { findBySlug: vi.fn().mockResolvedValue(null), findById: vi.fn().mockRejectedValue(new Error('not found')) };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const routingRepo = {
    findCandidates: vi.fn().mockResolvedValue([]),
    clearDefaultFor: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async (entity: any) => entity),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: any) => entity),
  };
  const trx = { $lane: 'transaction' };
  const unitOfWork = { runInTransaction: vi.fn().mockImplementation(async (work: any) => work(trx)) };
  const routingService = { resolveDefault: vi.fn().mockResolvedValue({ tenantId: TENANT, taskKey: 'guardrail.validate', source: null, policy: null, model: null }) };
  const svc = new AiTaskDefaultService(modelRepo as any, db as any, routingRepo as any, unitOfWork as any, routingService as any, emitter as any, cls as any);
  return { svc, modelRepo, emitter, routingRepo, unitOfWork, routingService, trx, db };
}

describe('AiTaskDefaultService — getEffective (facade over resolveDefault)', () => {
  // `text.live` carries this case: it is what is LEFT of the tenant-configurable
  // lane after TASK-872 pinned the guardrail plane to SYSTEM.
  it('projects the tenant-tier answer: slug from the FK model, configJson from the row, source tenant', async () => {
    const { svc, routingService } = makeService();
    const model = makeModel({ slug: 'tenant-guardian' });
    routingService.resolveDefault.mockResolvedValue({ tenantId: TENANT, taskKey: 'text.live', source: 'tenant', policy: makePolicy({ configJson: { threshold: 0.7 } }), model });

    const res = await svc.getEffective('text.live');

    expect(routingService.resolveDefault).toHaveBeenCalledWith(TENANT, 'text.live', { systemOnly: false });
    expect(res.source).toBe('tenant');
    expect(res.modelSlug).toBe('tenant-guardian');
    expect(res.configJson).toEqual({ threshold: 0.7 });
    expect(res.model?.slug).toBe('tenant-guardian');
  });

  it('asks for SYSTEM only on the SUPER_ADMIN-only keys (nlp.*, harness.*, guardrail.*)', async () => {
    const { svc, routingService } = makeService();
    await svc.getEffective('nlp.ner');
    expect(routingService.resolveDefault).toHaveBeenCalledWith(TENANT, 'nlp.ner', { systemOnly: true });
  });

  // TASK-872, owner decision #3 (2026-09-05): guardrail is platform-only, so a
  // tenant row for a `guardrail.*` key never wins at runtime — the read is
  // pinned to SYSTEM exactly as it is for `nlp.*` / `harness.*`.
  it('pins the guardrail safety plane to SYSTEM too', async () => {
    const { svc, routingService } = makeService();
    await svc.getEffective('guardrail.validate');
    expect(routingService.resolveDefault).toHaveBeenCalledWith(TENANT, 'guardrail.validate', { systemOnly: true });
  });

  it('returns source null + null model when neither tier has a configuration', async () => {
    const { svc } = makeService();
    const res = await svc.getEffective('guardrail.validate');
    expect(res).toEqual({ tenantId: TENANT, taskKey: 'guardrail.validate', modelSlug: null, source: null, configJson: null, model: null });
  });

  it('falls back to the row modelRef for the slug when the FK model is not readable', async () => {
    const { svc, routingService } = makeService();
    const policy = makePolicy();
    policy.modelRef = 'wire-id';
    routingService.resolveDefault.mockResolvedValue({ tenantId: TENANT, taskKey: 'guardrail.validate', source: 'system', policy, model: null });
    const res = await svc.getEffective('guardrail.validate');
    expect(res.modelSlug).toBe('wire-id');
    expect(res.model).toBeNull();
  });

  it('rejects an unknown task key', async () => {
    const { svc } = makeService();
    await expect(svc.getEffective('not.a.key')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('honours an explicit tenantId (super admin acting on another tenant)', async () => {
    const { svc, routingService } = makeService({ roles: ['SUPER_ADMIN'] });
    // `text.live` rather than a guardrail key: guardrail resolves SYSTEM-only
    // since TASK-872, so it can no longer demonstrate the tenant hand-off.
    await svc.getEffective('text.live', 'tenant-other');
    expect(routingService.resolveDefault).toHaveBeenCalledWith('tenant-other', 'text.live', { systemOnly: false });
  });
});

describe('AiTaskDefaultService — getRow (the tenant-owned elected routing row)', () => {
  it('returns a version:0 placeholder when the tenant has no elected configuration', async () => {
    const { svc, routingRepo } = makeService();
    const res = await svc.getRow('guardrail.validate');
    expect(res).toEqual({ tenantId: TENANT, taskKey: 'guardrail.validate', modelSlug: null, configJson: null, version: 0 });
    // Own rows only, in ANY status — the row an OCC write will CAS against.
    expect(routingRepo.findCandidates).toHaveBeenCalledWith([TENANT], 'guardrail.validate', undefined, { activeOnly: false, enabledOnly: false });
  });

  it('projects the elected row: routing version drives the OCC token, slug from the FK model', async () => {
    const { svc, routingRepo, modelRepo } = makeService();
    const policy = makePolicy({ configJson: { k: 1 } });
    routingRepo.findCandidates.mockResolvedValue([makePolicy({ isDefault: false }), policy]);
    modelRepo.findById.mockResolvedValue(makeModel({ slug: 'granite' }));
    const res = await svc.getRow('guardrail.validate');
    expect(res.version).toBe(policy.version);
    expect(res.modelSlug).toBe('granite');
    expect(res.configJson).toEqual({ k: 1 });
  });
});

describe('AiTaskDefaultService — upsertRow validation', () => {
  it('rejects an unknown task key', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(svc.upsertRow('bogus.key', { modelSlug: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a slug that resolves to no ENABLED model in [tenant, SYSTEM]', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(svc.upsertRow('nlp.ner', { modelSlug: 'ghost', expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a slug whose taskType does not match the task key', async () => {
    const { svc, modelRepo } = makeService({ roles: ['SUPER_ADMIN'] });
    modelRepo.findBySlug.mockResolvedValue(makeModel({ taskType: ModelTaskType.GUARDRAIL }));
    await expect(svc.upsertRow('nlp.ner', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 })).rejects.toThrow(/requires/);
  });
});

describe('AiTaskDefaultService — governance', () => {
  it('rejects an nlp.* write from a tenant admin with ForbiddenException (403, not 404)', async () => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'] });
    await expect(svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a text.* write from a tenant admin', async () => {
    const { svc, modelRepo, routingRepo } = makeService({ roles: ['TENANT_ADMIN'] });
    modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'gemma', taskType: ModelTaskType.TEXT_GENERATION }));
    await svc.upsertRow('text.finalize', { modelSlug: 'gemma', expectedVersion: 0 });
    expect(routingRepo.create).toHaveBeenCalled();
  });

  it('guardrail.* from a tenant admin: 403 unless the slug is on the platform-approved (SYSTEM) list', async () => {
    const { svc, modelRepo } = makeService({ roles: ['TENANT_ADMIN'] });
    // Only a TENANT-owned row exists for the slug — not approved.
    modelRepo.findBySlug.mockImplementation(async (tenantId: string) => (tenantId === SYSTEM_TENANT_ID ? null : makeModel({ tenantId: TENANT })));
    await expect(svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a SUPER_ADMIN writing the SYSTEM row is exempt from the guardrail floor', async () => {
    const { svc, modelRepo, routingRepo } = makeService({ roles: ['SUPER_ADMIN'], clsTenantId: SYSTEM_TENANT_ID });
    modelRepo.findBySlug.mockResolvedValue(makeModel());
    await svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 }, SYSTEM_TENANT_ID);
    expect(routingRepo.create).toHaveBeenCalled();
  });
});

describe('AiTaskDefaultService — writes land ONLY on the elected AiRoutingPolicy row', () => {
  let ctx: ReturnType<typeof makeService>;
  const model = makeModel();
  beforeEach(() => {
    ctx = makeService({ roles: ['SUPER_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(model);
  });

  it('CREATE: frees the election slot, inserts an ACTIVE elected row carrying the catalogue FK (not the slug), emits ResourceCreated', async () => {
    const res = await ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, configJson: { threshold: 0.9 }, expectedVersion: 0 });

    expect(ctx.unitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.routingRepo.clearDefaultFor).toHaveBeenCalledWith(TENANT, 'guardrail.validate', null, ctx.trx, 'u1');
    const [entity, tx] = ctx.routingRepo.create.mock.calls[0];
    expect(tx).toBe(ctx.trx);
    expect(entity.modelId).toBe(model.id);
    expect(entity.isDefault).toBe(true);
    expect(entity.status).toBe(AiRoutingPolicyStatus.ACTIVE);
    expect(entity.configJson).toEqual({ threshold: 0.9 });
    expect(res.modelSlug).toBe(model.slug);
    expect(res.version).toBe(1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceType: ResourceType.AiRoutingPolicy, data: expect.objectContaining({ taskKey: 'guardrail.validate', modelSlug: model.slug }) }),
    );
  });

  it('CREATE with a non-zero expectedVersion is a concurrency conflict', async () => {
    await expect(ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, expectedVersion: 3 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(ctx.routingRepo.create).not.toHaveBeenCalled();
  });

  it('UPDATE: CASes on the routing row version, updates the FK in place, emits ResourceUpdated', async () => {
    const elected = makePolicy({ modelId: 'old-model' });
    ctx.routingRepo.findCandidates.mockResolvedValue([elected]);

    const res = await ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, expectedVersion: elected.version });

    expect(ctx.routingRepo.updateWithVersion).toHaveBeenCalledWith(elected.id, elected, elected.version, ctx.trx);
    expect(elected.modelId).toBe(model.id);
    expect(ctx.routingRepo.create).not.toHaveBeenCalled();
    expect(res.modelSlug).toBe(model.slug);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceType: ResourceType.AiRoutingPolicy }));
  });

  it('UPDATE without a token, or with a stale one, is 412 — even when the payload would change nothing', async () => {
    const elected = makePolicy({ modelId: model.id });
    ctx.routingRepo.findCandidates.mockResolvedValue([elected]);
    await expect(ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    await expect(ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, expectedVersion: 99 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('re-PUTting the stored value is idempotent: current row back, no write, no event', async () => {
    const elected = makePolicy({ modelId: model.id, displayName: model.slug });
    ctx.routingRepo.findCandidates.mockResolvedValue([elected]);
    const res = await ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, expectedVersion: elected.version });
    expect(res.version).toBe(elected.version);
    expect(ctx.routingRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(ctx.emitter.emit).not.toHaveBeenCalled();
  });

  it('routes a foreign-tenant write from a super admin through the unscoped base-client lane', async () => {
    await ctx.svc.upsertRow('guardrail.validate', { modelSlug: model.slug, expectedVersion: 0 }, SYSTEM_TENANT_ID);
    expect(ctx.routingRepo.findCandidates).toHaveBeenCalledWith([SYSTEM_TENANT_ID], 'guardrail.validate', ctx.db.baseClient, { activeOnly: false, enabledOnly: false });
    expect(ctx.modelRepo.findBySlug).toHaveBeenCalledWith(SYSTEM_TENANT_ID, model.slug, ctx.db.baseClient);
  });
});
