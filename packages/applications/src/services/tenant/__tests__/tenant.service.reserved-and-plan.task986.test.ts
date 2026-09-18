/**
 * TASK-986 W1 + W2 — reserved-tenant lockdown and the `plan` field gate.
 *
 * Two holes this file exists to keep closed:
 *
 *  1. `assertNotSystemTenant` used to match the Global reserved row ONLY by its
 *     MUTABLE `key` (`__GLOBAL__`), never by `SEED_TENANT_ID`. The pre-existing
 *     lifecycle suite builds its fixture with a RANDOM id and key `__GLOBAL__`,
 *     so it proved the key branch and nothing else — a PATCH renaming the key
 *     permanently disarmed the guard. Every case below therefore uses the
 *     LITERAL reserved ids and a NON-reserved key.
 *  2. `update()` called no reserved guard at all, and `plan` had no field-level
 *     privilege gate, so a tenant admin could raise its own plan (owner ruling
 *     D-1: super admin only) and anyone could `DISABLE` the platform tier
 *     (owner ruling D-5: block ALL PATCH edits on both reserved rows).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { TenantEntity, TenantPlan, ResourceStatusType } from '@arcaai/domains';
import { TenantService } from '../tenant.service';
import type { UpdateTenantRequest } from '../dto';

/** The two reserved rows, written out as LITERALS on purpose (see the header). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const ORDINARY_TENANT_ID = '01920000-0000-7000-8000-00000000abcd';

const mockTenantRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};

let requestUserRoles: string[] = [];

const mockClsService = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: requestUserRoles } : null)),
  set: vi.fn(),
};

const mockEventEmitter = { emit: vi.fn() };

const mockTenantBucketService = {
  provisionSystemBuckets: vi.fn(),
  applyPlanStorageQuota: vi.fn(),
};

const mockBillingService = {
  recordPlanChange: vi.fn(),
};

const mockReferenceSetService = {
  provision: vi.fn().mockResolvedValue({ warnings: [] }),
};

const stub = {} as never;

function buildService(): TenantService {
  return new TenantService(
    mockTenantRepository as never,
    stub, // globalSettingRepository
    stub, // departmentRepository
    stub, // promptTemplateRepository
    { findEnabledPipelines: vi.fn().mockResolvedValue([]) } as never, // asrPipelineRepository
    { baseClient: { department: { findMany: vi.fn().mockResolvedValue([]) } } } as never, // databaseService
    mockTenantBucketService as never,
    mockEventEmitter as never,
    mockClsService as never,
    stub, // _retiredAiModelRepository
    stub, // asrPipelineVersionRepository
    mockReferenceSetService as never,
    mockBillingService as never,
  );
}

/**
 * A persisted row at the given id. Built with `new TenantEntity` rather than
 * the factory because the factory mints its own UUIDv7 and these cases are
 * ABOUT the two literal ids.
 */
function makeTenant(id: string, key: string, plan: TenantPlan | null = TenantPlan.STARTER): TenantEntity {
  const tenant = new TenantEntity({
    id,
    name: `Tenant ${key}`,
    key,
    description: '',
    plan,
    trialEndsAt: null,
    tags: [],
    Tags: [],
    resourceStatus: ResourceStatusType.ENABLED,
  } as never);
  tenant.clearChanges();
  return tenant;
}

function patch(overrides: Partial<UpdateTenantRequest> = {}): UpdateTenantRequest {
  return { expectedVersion: 1, ...overrides } as UpdateTenantRequest;
}

describe('TenantService — reserved tenants (TASK-986 W1 / owner ruling D-5)', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    requestUserRoles = ['SUPER_ADMIN'];
    service = buildService();
    mockTenantRepository.update.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
    mockTenantRepository.updateWithVersion.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
    mockTenantRepository.softDelete.mockImplementation(async (_id: string) => makeTenant(ORDINARY_TENANT_ID, 'ACME'));
    mockReferenceSetService.provision.mockResolvedValue({ warnings: [] });
  });

  // ── update() — the hole: no guard at all ─────────────────────────────────

  it('update() is BLOCKED on the SYSTEM tenant by its literal id', async () => {
    // Key deliberately NOT `__GLOBAL__`: the id is what must carry the guard.
    mockTenantRepository.findById.mockResolvedValue(makeTenant(SYSTEM_TENANT_ID, '__SYSTEM__'));

    await expect(service.update(SYSTEM_TENANT_ID, patch({ resourceStatus: ResourceStatusType.DISABLED }))).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('update() is BLOCKED on the Global tenant by its literal id even when the key was renamed away from __GLOBAL__', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(GLOBAL_TENANT_ID, 'renamed-global'));

    await expect(service.update(GLOBAL_TENANT_ID, patch({ name: 'Anything' }))).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('update() still writes an ordinary tenant', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME'));

    await service.update(ORDINARY_TENANT_ID, patch({ name: 'Acme Renamed' }));

    expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  // ── suspend / archive / delete — now matched by ID, not only by key ──────

  it.each([
    ['SYSTEM', SYSTEM_TENANT_ID, '__SYSTEM__'],
    ['Global', GLOBAL_TENANT_ID, 'renamed-global'],
  ])('suspend() is BLOCKED on the %s tenant by id', async (_label, id, key) => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(id, key));

    await expect(service.suspend(id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.update).not.toHaveBeenCalled();
  });

  it.each([
    ['SYSTEM', SYSTEM_TENANT_ID, '__SYSTEM__'],
    ['Global', GLOBAL_TENANT_ID, 'renamed-global'],
  ])('archive() is BLOCKED on the %s tenant by id', async (_label, id, key) => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(id, key));

    await expect(service.archive(id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.update).not.toHaveBeenCalled();
  });

  it.each([
    ['SYSTEM', SYSTEM_TENANT_ID, '__SYSTEM__'],
    ['Global', GLOBAL_TENANT_ID, 'renamed-global'],
  ])('deleteById() is BLOCKED on the %s tenant by id', async (_label, id, key) => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(id, key));

    await expect(service.deleteById(id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.softDelete).not.toHaveBeenCalled();
  });
});

describe('TenantService — the `plan` field gate (TASK-986 W2 / owner ruling D-1)', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    requestUserRoles = [];
    service = buildService();
    mockTenantRepository.updateWithVersion.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
  });

  it('a tenant admin PATCHing `plan` is refused with 403', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    await expect(service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.ENTERPRISE }))).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a tenant admin may still PATCH other fields', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    await service.update(ORDINARY_TENANT_ID, patch({ description: 'New description' }));

    expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('the gate fires only on an ACTUAL change: echoing the current plan is not a plan change', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    // `plan` equals the stored value, so the only real change is `name`.
    await service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.STARTER, name: 'Acme Renamed' }));

    expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('a SUPER_ADMIN may set the plan', async () => {
    requestUserRoles = ['SUPER_ADMIN'];
    service = buildService();
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    const result = await service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.ENTERPRISE }));

    expect(result.plan).toBe(TenantPlan.ENTERPRISE);
    expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('EXISTENCE is resolved before privilege: an unknown id is still a 404, never a 403 oracle', async () => {
    mockTenantRepository.findById.mockRejectedValue(new DataNotFoundException('Tenant not found'));

    await expect(service.update('01920000-0000-7000-8000-0000000000ff', patch({ plan: TenantPlan.ENTERPRISE }))).rejects.toThrow(
      DataNotFoundException,
    );
  });
});

describe('TenantService — plan-change side effects (TASK-986 W2 / owner ruling D-7)', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    requestUserRoles = ['SUPER_ADMIN'];
    // `clearAllMocks` clears calls, not implementations — restore the default
    // CLS reader so the rebind case below cannot leak into its neighbours.
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1', roles: requestUserRoles } : null));
    service = buildService();
    mockTenantRepository.updateWithVersion.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
    mockBillingService.recordPlanChange.mockResolvedValue(undefined);
    mockReferenceSetService.provision.mockResolvedValue({ warnings: [] });
  });

  it('update() records the plan change in TenantPlanHistory and re-applies the plan storage quota', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    await service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.PRO }));

    expect(mockBillingService.recordPlanChange).toHaveBeenCalledWith(ORDINARY_TENANT_ID, TenantPlan.PRO, expect.any(Date), expect.any(String));
    expect(mockTenantBucketService.applyPlanStorageQuota).toHaveBeenCalledWith(ORDINARY_TENANT_ID, TenantPlan.PRO);
  });

  it('binds CLS to the TARGET tenant for the side effects, then restores the caller context', async () => {
    // A super admin editing tenant B while their working tenant is A: the
    // tenant-scope Prisma extension reads CLS, so without the rebind the
    // explicit `tenantId: B` on the plan-history row is refused as a mismatch
    // and the write is silently lost.
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'admin-1', roles: requestUserRoles };
      if (key === 'tenantId') return 'other-working-tenant';
      return null;
    });
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));
    mockBillingService.recordPlanChange.mockImplementation(async () => {
      expect(mockClsService.set).toHaveBeenLastCalledWith('tenantId', ORDINARY_TENANT_ID);
    });

    await service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.PRO }));

    expect(mockBillingService.recordPlanChange).toHaveBeenCalledTimes(1);
    expect(mockClsService.set).toHaveBeenLastCalledWith('tenantId', 'other-working-tenant');
  });

  it('update() does NOT touch plan history when the patch changes no plan', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));

    await service.update(ORDINARY_TENANT_ID, patch({ name: 'Acme Renamed' }));

    expect(mockBillingService.recordPlanChange).not.toHaveBeenCalled();
    expect(mockTenantBucketService.applyPlanStorageQuota).not.toHaveBeenCalled();
  });

  it('a plan-history write that fails does not fail the PATCH (best-effort, like every other side effect)', async () => {
    mockTenantRepository.findById.mockResolvedValue(makeTenant(ORDINARY_TENANT_ID, 'ACME', TenantPlan.STARTER));
    mockBillingService.recordPlanChange.mockRejectedValueOnce(new Error('db down'));

    await expect(service.update(ORDINARY_TENANT_ID, patch({ plan: TenantPlan.PRO }))).resolves.toBeDefined();
  });

  it('create() opens the first plan-history window', async () => {
    const created = makeTenant(ORDINARY_TENANT_ID, 'acme', TenantPlan.PRO);
    mockTenantRepository.create.mockResolvedValue(created);

    await service.create({ name: 'Acme', key: 'acme', plan: TenantPlan.PRO } as never);

    expect(mockBillingService.recordPlanChange).toHaveBeenCalledWith(ORDINARY_TENANT_ID, TenantPlan.PRO, expect.any(Date), expect.any(String));
  });
});
