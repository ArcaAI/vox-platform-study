/**
 * AiTaskDefaultService — unit tests.
 *
 * Mirrors the `tenant-tts-config` test style: repositories, EventEmitter2 and
 * ClsService are mocked; the effective cascade (tenant row → SYSTEM row →
 * null), upsert validation (task key, slug resolution, taskType
 * compatibility), the guardrail.* global-admin governance rule, OCC semantics
 * and sys-event broadcasting are asserted.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelFactory,
  AiModelFormat,
  AiModelSource,
  AiTaskDefaultFactory,
  ModelCategory,
  ModelTaskType,
  ModelType,
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

function makeRow(overrides: { tenantId?: string; taskKey?: string; modelSlug?: string; configJson?: Record<string, unknown> | null } = {}) {
  return AiTaskDefaultFactory.CreateAiTaskDefault({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'nlp.ner',
    modelSlug: overrides.modelSlug ?? 'medical-ner',
    configJson: overrides.configJson ?? null,
  });
}

function makeService(opts: { roles?: string[]; clsTenantId?: string | null } = {}) {
  const repo = { findByTenantAndTaskKey: vi.fn().mockResolvedValue(null), create: vi.fn(), updateWithVersion: vi.fn() };
  const modelRepo = { findBySlug: vi.fn().mockResolvedValue(null) };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  // r2605 Finding A — the UNSCOPED base client the cross-tenant lane routes through.
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const svc = new AiTaskDefaultService(repo as any, modelRepo as any, db as any, emitter as any, cls as any);
  return { svc, repo, modelRepo, emitter, db };
}

describe('AiTaskDefaultService — getEffective', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('ignores tenant override rows for GLOBAL_ADMIN-only keys (SYSTEM wins)', async () => {
    ctx.repo.findByTenantAndTaskKey.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID
        ? makeRow({ tenantId: SYSTEM_TENANT_ID, modelSlug: 'medical-ner' })
        : makeRow({ tenantId: TENANT, modelSlug: 'tenant-custom-ner' }),
    );
    ctx.modelRepo.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      makeModel({ tenantId, slug, taskType: ModelTaskType.TOKEN_CLASSIFICATION }),
    );

    const eff = await ctx.svc.getEffective('nlp.ner');

    expect(eff.source).toBe('system');
    expect(eff.modelSlug).toBe('medical-ner');
    expect(eff.model?.slug).toBe('medical-ner');
    // Tenant row must not be consulted for nlp.* (SYSTEM-only resolution).
    expect(ctx.repo.findByTenantAndTaskKey).not.toHaveBeenCalledWith(TENANT, 'nlp.ner', undefined);
    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.ner', undefined);
  });

  it('resolves the SYSTEM row for nlp.* (source: system)', async () => {
    ctx.repo.findByTenantAndTaskKey.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? makeRow({ tenantId: SYSTEM_TENANT_ID, modelSlug: 'medical-ner' }) : null,
    );
    ctx.modelRepo.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      tenantId === SYSTEM_TENANT_ID ? makeModel({ tenantId, slug, taskType: ModelTaskType.TOKEN_CLASSIFICATION }) : null,
    );

    const eff = await ctx.svc.getEffective('nlp.ner');

    expect(eff.source).toBe('system');
    expect(eff.modelSlug).toBe('medical-ner');
    expect(eff.model?.slug).toBe('medical-ner');
  });

  it('returns source null + null model when neither tenant nor SYSTEM row exists', async () => {
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    const eff = await ctx.svc.getEffective('guardrail.validate');

    expect(eff).toMatchObject({ taskKey: 'guardrail.validate', modelSlug: null, source: null, model: null });
    expect(ctx.modelRepo.findBySlug).not.toHaveBeenCalled();
  });

  it('resolves the SYSTEM model slug against the tenant-visible registry for nlp.*', async () => {
    ctx.repo.findByTenantAndTaskKey.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? makeRow({ tenantId: SYSTEM_TENANT_ID, modelSlug: 'medical-ner' }) : null,
    );
    const systemModel = makeModel({ tenantId: SYSTEM_TENANT_ID, slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION });
    ctx.modelRepo.findBySlug.mockImplementation(async (tenantId: string) =>
      tenantId === TENANT || tenantId === SYSTEM_TENANT_ID ? systemModel : null,
    );

    const eff = await ctx.svc.getEffective('nlp.ner');

    expect(eff.source).toBe('system');
    expect(eff.model?.slug).toBe('medical-ner');
    expect(ctx.modelRepo.findBySlug).toHaveBeenCalledWith(TENANT, 'medical-ner', undefined);
  });

  it('rejects an unknown task key', async () => {
    await expect(ctx.svc.getEffective('smr.summarize')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('AiTaskDefaultService — getRow', () => {
  it('returns a version:0 placeholder when the tenant has no row', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    const row = await ctx.svc.getRow('nlp.ner');

    expect(row).toMatchObject({ tenantId: TENANT, taskKey: 'nlp.ner', modelSlug: null, version: 0 });
  });

  it('returns the raw persisted row when present', async () => {
    const ctx = makeService();
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(makeRow({ configJson: { threshold: 0.9 } }));

    const row = await ctx.svc.getRow('nlp.ner');

    expect(row).toMatchObject({ taskKey: 'nlp.ner', modelSlug: 'medical-ner', version: 1, configJson: { threshold: 0.9 } });
  });
});

describe('AiTaskDefaultService — upsertRow validation', () => {
  it('rejects an unknown task key', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    await expect(ctx.svc.upsertRow('nope.key', { modelSlug: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a slug that resolves to no ENABLED model in [tenant, SYSTEM]', async () => {
    // The repository's findBySlug filters ENABLED-only, so a DISABLED or
    // soft-deleted model resolves to null exactly like an unknown slug.
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(null);

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'ghost-model', expectedVersion: 0 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a slug whose taskType does not match the task key', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    // nlp.ner requires TOKEN_CLASSIFICATION; hand it a TEXT_GENERATION model.
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'lms-gemma-4-e2b-it-qat', taskType: ModelTaskType.TEXT_GENERATION }));

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'lms-gemma-4-e2b-it-qat', expectedVersion: 0 })).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );
  });
});

describe('AiTaskDefaultService — GLOBAL_ADMIN-only governance', () => {
  it('rejects a guardrail.* write from a tenant admin with ForbiddenException (privilege rule, not a tenancy probe)', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ taskType: ModelTaskType.GUARDRAIL }));

    await expect(ctx.svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it('accepts a guardrail.* write from a GLOBAL_ADMIN', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ taskType: ModelTaskType.GUARDRAIL }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 });

    expect(res.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(ctx.repo.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an nlp.* write from a tenant admin with ForbiddenException', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it('accepts an nlp.* write from a GLOBAL_ADMIN', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 0 });

    expect(res.modelSlug).toBe('medical-ner');
  });

  it('accepts an smr.* write from a tenant admin (SMR routing is now tenant-configurable)', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'lms-gemma-4-e2b-it-qat', taskType: ModelTaskType.TEXT_GENERATION }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('smr.live', { modelSlug: 'lms-gemma-4-e2b-it-qat', expectedVersion: 0 });

    expect(res.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    expect(ctx.repo.create).toHaveBeenCalledTimes(1);
  });

  it('accepts an smr.finalize write from a tenant admin for their own tenant', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'lms-gemma-4-e2b-it-qat', taskType: ModelTaskType.TEXT_GENERATION }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('smr.finalize', { modelSlug: 'lms-gemma-4-e2b-it-qat', expectedVersion: 0 });

    expect(res.tenantId).toBe(TENANT);
    expect(res.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    // Same-tenant caller → scoped path (no cross-tenant base-client lane).
    expect(ctx.repo.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), undefined);
  });

  it('accepts an smr.finalize.fallback write from a tenant admin', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'lms-gemma-4-e2b-it-qat', taskType: ModelTaskType.TEXT_GENERATION }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('smr.finalize.fallback', { modelSlug: 'lms-gemma-4-e2b-it-qat', expectedVersion: 0 });

    expect(res.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    expect(ctx.repo.create).toHaveBeenCalledTimes(1);
  });
});

describe('AiTaskDefaultService — upsertRow OCC + sys-events', () => {
  it('creates the row + broadcasts ResourceCreated when none exists (expectedVersion 0)', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    await ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', configJson: { note: 'x' }, expectedVersion: 0 });

    expect(ctx.repo.create).toHaveBeenCalledTimes(1);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
    const created = ctx.repo.create.mock.calls[0][0];
    expect(created.tenantId).toBe(TENANT);
    expect(created.taskKey).toBe('nlp.ner');
    expect(created.configJson).toEqual({ note: 'x' });
  });

  it('create with a non-zero expectedVersion is a concurrency conflict', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 3 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('updates via compare-and-set + broadcasts ResourceUpdated when a row exists', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'symps-disease-bert-v3-c41', taskType: ModelTaskType.TEXT_CLASSIFICATION }));
    const row = makeRow({ taskKey: 'nlp.classification', modelSlug: 'old-slug' });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(row);
    ctx.repo.updateWithVersion.mockImplementation(async () => row);

    await ctx.svc.upsertRow('nlp.classification', { modelSlug: 'symps-disease-bert-v3-c41', expectedVersion: 1 });

    // Same-tenant caller → the scoped path (no base-client tx).
    expect(ctx.repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, undefined);
    expect(ctx.emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
  });

  it('propagates OCC drift from the repository', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));
    const row = makeRow({ modelSlug: 'old-slug' });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(row);
    ctx.repo.updateWithVersion.mockRejectedValue(
      new OptimisticConcurrencyException('AiTaskDefault', row.id, { expectedVersion: 1, currentVersion: 2 }),
    );

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 1 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('throws when there are no changes to write', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ slug: 'medical-ner', taskType: ModelTaskType.TOKEN_CLASSIFICATION }));
    // Same editor + same slug → nothing changes, the guard fires.
    const row = AiTaskDefaultFactory.CreateAiTaskDefault({ tenantId: TENANT, taskKey: 'nlp.ner', modelSlug: 'medical-ner', updatedBy: 'u1' });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(row);

    await expect(ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 1 })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('honors an explicit tenantId override (global admin acting on another tenant)', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'] });
    ctx.modelRepo.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      makeModel({ tenantId, slug, taskType: ModelTaskType.TOKEN_CLASSIFICATION }),
    );
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('nlp.ner', { modelSlug: 'medical-ner', expectedVersion: 0 }, 'tenant-other');

    expect(res.tenantId).toBe('tenant-other');
    // Cross-tenant global-admin write → routed through the base-client lane.
    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith('tenant-other', 'nlp.ner', ctx.db.baseClient);
  });
});

/**
 * r2605 Finding A — SYSTEM/cross-tenant reads+writes must bypass the
 * tenant-scoped extended client. With a global admin's working tenant W
 * elevated into CLS, targeting `?tenantId=SYSTEM` through the extended client
 * makes the tenant-scope extension inject W: the CAS update matches 0 rows
 * (eternal 412), the create throws `TenantScope: tenantId mismatch` (500) and
 * reads silently miss. The service must route the whole target-tenant
 * read/write set through the UNSCOPED base client whenever the resolved
 * target differs from the CLS tenant (or CLS is empty) AND the caller is a
 * global admin. Tenant admins stay on the scoped path byte-for-byte.
 */
describe('AiTaskDefaultService — cross-tenant base-client lane', () => {
  it('getRow targeting SYSTEM under an elevated working tenant W routes the read through the base client', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: TENANT });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    await ctx.svc.getRow('nlp.ner', SYSTEM_TENANT_ID);

    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.ner', ctx.db.baseClient);
  });

  it('getEffective targeting a foreign tenant routes SYSTEM-only nlp.* reads AND model resolution through the base client', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: TENANT });
    ctx.repo.findByTenantAndTaskKey.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? makeRow({ tenantId: SYSTEM_TENANT_ID, modelSlug: 'medical-ner' }) : null,
    );
    ctx.modelRepo.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      makeModel({ tenantId, slug, taskType: ModelTaskType.TOKEN_CLASSIFICATION }),
    );

    const eff = await ctx.svc.getEffective('nlp.ner', 'tenant-other');

    expect(eff.source).toBe('system');
    expect(ctx.repo.findByTenantAndTaskKey).not.toHaveBeenCalledWith('tenant-other', 'nlp.ner', ctx.db.baseClient);
    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.ner', ctx.db.baseClient);
    expect(ctx.modelRepo.findBySlug).toHaveBeenCalledWith('tenant-other', 'medical-ner', ctx.db.baseClient);
  });

  it('upsert CREATE targeting SYSTEM under working tenant W persists via the base client (no TenantScope mismatch)', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: TENANT });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ taskType: ModelTaskType.GUARDRAIL }));
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);
    ctx.repo.create.mockImplementation(async (e: unknown) => e);

    const res = await ctx.svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 }, SYSTEM_TENANT_ID);

    expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(ctx.repo.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }), ctx.db.baseClient);
  });

  it('upsert CAS targeting SYSTEM under working tenant W runs updateWithVersion through the base client (no eternal 412)', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: TENANT });
    ctx.modelRepo.findBySlug.mockResolvedValue(makeModel({ taskType: ModelTaskType.GUARDRAIL }));
    const row = makeRow({ tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.validate', modelSlug: 'old-slug' });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(row);
    ctx.repo.updateWithVersion.mockImplementation(async () => row);

    await ctx.svc.upsertRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 1 }, SYSTEM_TENANT_ID);

    expect(ctx.repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, ctx.db.baseClient);
  });

  it('global admin with an EMPTY CLS tenant (not elevated) also uses the base-client lane', async () => {
    const ctx = makeService({ roles: ['GLOBAL_ADMIN'], clsTenantId: null });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    await ctx.svc.getRow('nlp.ner', TENANT);

    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith(TENANT, 'nlp.ner', ctx.db.baseClient);
  });

  it('a NON-admin caller acting on their own tenant never gets the base-client lane (getRow)', async () => {
    const ctx = makeService({ roles: ['TENANT_ADMIN'], clsTenantId: TENANT });
    ctx.repo.findByTenantAndTaskKey.mockResolvedValue(null);

    await ctx.svc.getRow('nlp.ner');

    expect(ctx.repo.findByTenantAndTaskKey).toHaveBeenCalledWith(TENANT, 'nlp.ner', undefined);
  });
});
