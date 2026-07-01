/**
 * TASK-387 (#1 / #2) — TenantService lifecycle + tags unit tests.
 *
 * Covers the SUSPENDED/ARCHIVED/restore transitions, the DEF-ADM-002
 * system-tenant guard (suspend/archive/delete blocked on `__GLOBAL__`), and the
 * `setTags` set-semantics. Uses REAL `TenantEntity` instances (via the factory)
 * so the entity lifecycle methods + change tracking run for real; the repository
 * + cls + event-emitter are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { TenantService } from '../tenant.service';
import { TenantFactory, ResourceStatusType, SysEventType, type TenantEntity } from '@arcaai/domains';

const mockTenantRepository = {
  findById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};

const mockClsService = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: [] } : null)),
  set: vi.fn(),
};

const mockEventEmitter = { emit: vi.fn() };

const stub = {} as never;

function buildService(): TenantService {
  return new TenantService(
    mockTenantRepository as never,
    stub, // globalSettingRepository
    stub, // departmentRepository
    stub, // promptTemplateRepository
    stub, // asrPipelineRepository
    stub, // databaseService
    stub, // tenantBucketService
    mockEventEmitter as never,
    mockClsService as never,
    stub, // aiModelRepository
    stub, // asrPipelineVersionRepository
  );
}

function makeTenant(key = 'ACME', name = 'Acme Health'): TenantEntity {
  const tenant = TenantFactory.CreateTenant({ name, key });
  tenant.clearChanges(); // simulate a persisted, change-free row
  return tenant;
}

describe('TenantService — lifecycle (TASK-387 #1)', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildService();
    // update echoes back the (mutated) entity, mirroring the real repo round-trip.
    mockTenantRepository.update.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
  });

  it('suspend() moves an ordinary tenant to SUSPENDED and persists via update()', async () => {
    const tenant = makeTenant('ACME');
    mockTenantRepository.findById.mockResolvedValue(tenant);

    const result = await service.suspend(tenant.id);

    expect(result.resourceStatus).toBe(ResourceStatusType.SUSPENDED);
    expect(mockTenantRepository.update).toHaveBeenCalledWith(tenant.id, tenant);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
  });

  it('archive() moves an ordinary tenant to ARCHIVED', async () => {
    const tenant = makeTenant('ACME');
    mockTenantRepository.findById.mockResolvedValue(tenant);

    const result = await service.archive(tenant.id);

    expect(result.resourceStatus).toBe(ResourceStatusType.ARCHIVED);
    expect(mockTenantRepository.update).toHaveBeenCalledTimes(1);
  });

  it('restore() returns a suspended/archived tenant to ENABLED', async () => {
    const tenant = makeTenant('ACME');
    tenant.suspend();
    tenant.clearChanges();
    mockTenantRepository.findById.mockResolvedValue(tenant);

    const result = await service.restore(tenant.id);

    expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
    expect(mockTenantRepository.update).toHaveBeenCalledTimes(1);
  });

  // ---- DEF-ADM-002 — system tenant protection ------------------------------

  it('suspend() is BLOCKED on the __GLOBAL__ system tenant (DEF-ADM-002)', async () => {
    const globalTenant = makeTenant('__GLOBAL__', 'Global');
    mockTenantRepository.findById.mockResolvedValue(globalTenant);

    await expect(service.suspend(globalTenant.id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.update).not.toHaveBeenCalled();
  });

  it('suspend() is BLOCKED case-insensitively (__global__)', async () => {
    const globalTenant = makeTenant('__global__', 'Global');
    mockTenantRepository.findById.mockResolvedValue(globalTenant);

    await expect(service.suspend(globalTenant.id)).rejects.toThrow(ForbiddenException);
  });

  it('archive() is BLOCKED on the system tenant (DEF-ADM-002)', async () => {
    const globalTenant = makeTenant('__GLOBAL__', 'Global');
    mockTenantRepository.findById.mockResolvedValue(globalTenant);

    await expect(service.archive(globalTenant.id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.update).not.toHaveBeenCalled();
  });

  it('deleteById() is BLOCKED on the system tenant (DEF-ADM-002)', async () => {
    const globalTenant = makeTenant('__GLOBAL__', 'Global');
    mockTenantRepository.findById.mockResolvedValue(globalTenant);

    await expect(service.deleteById(globalTenant.id)).rejects.toThrow(ForbiddenException);
    expect(mockTenantRepository.softDelete).not.toHaveBeenCalled();
  });

  it('deleteById() soft-deletes an ordinary tenant', async () => {
    const tenant = makeTenant('ACME');
    mockTenantRepository.findById.mockResolvedValue(tenant);
    mockTenantRepository.softDelete.mockResolvedValue(tenant);

    await service.deleteById(tenant.id);

    expect(mockTenantRepository.softDelete).toHaveBeenCalledWith(tenant.id);
  });
});

describe('TenantService — tags (TASK-387 #2)', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildService();
    mockTenantRepository.update.mockImplementation(async (_id: string, entity: TenantEntity) => entity);
  });

  it('setTags() replaces the full tag set and persists', async () => {
    const tenant = makeTenant('ACME');
    mockTenantRepository.findById.mockResolvedValue(tenant);

    const result = await service.setTags(tenant.id, ['priority', 'pilot']);

    expect(result.tags).toEqual(['priority', 'pilot']);
    expect(mockTenantRepository.update).toHaveBeenCalledTimes(1);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
  });

  it('setTags() clears all tags when given an empty array', async () => {
    const tenant = makeTenant('ACME');
    tenant.tags = ['old-a', 'old-b'];
    tenant.clearChanges();
    mockTenantRepository.findById.mockResolvedValue(tenant);

    const result = await service.setTags(tenant.id, []);

    expect(result.tags).toEqual([]);
    expect(mockTenantRepository.update).toHaveBeenCalledTimes(1);
  });
});
