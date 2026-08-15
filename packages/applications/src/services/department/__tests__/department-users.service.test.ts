/**
 * DepartmentService.getDepartmentUsers unit tests.
 *
 * Verifies the reverse dept->users listing: tenant scoping (no-existence-leak on
 * cross-tenant, super-admin cross-tenant bypass), the `UserDepartment` relational
 * filter (soft-deleted memberships excluded), and pagination pass-through.
 *
 * `UserDtoMapper` is mocked so the assertions stay focused on the service's
 * query + scoping behaviour (the real mapping is exercised by the e2e spec).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';

vi.mock('../../user/user/user.dto.mapper', () => ({
  UserDtoMapper: {
    // `getDepartmentUsers` now maps members MANUALLY (per-row, so it
    // can stamp `isLead`), so it calls `ToResponse` not `ToPaginatedResponse`.
    // Echo the user id so the service can key `isLead` off the mocked membership.
    ToResponse: vi.fn((u: { id: string }) => ({ id: u.id })),
  },
}));

import { DepartmentService } from '../department.service';

const mockDepartmentRepository = { findById: vi.fn() };
const mockUserRepository = { findAll: vi.fn(), count: vi.fn() };
const mockUserDepartmentRepository = { findAll: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

let clsUser: { id: string; roles: string[] } | null;
let clsTenantId: string | null;
const mockClsService = {
  get: vi.fn((key: string) => (key === 'user' ? clsUser : key === 'tenantId' ? clsTenantId : null)),
  set: vi.fn(),
};

function buildService(): DepartmentService {
  return new DepartmentService(
    mockDepartmentRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockUserRepository as never,
    undefined,
    mockUserDepartmentRepository as never,
  );
}

describe('DepartmentService.getDepartmentUsers', () => {
  let service: DepartmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    clsUser = { id: 'caller-1', roles: [] };
    clsTenantId = 'tenant-1';
    service = buildService();
  });

  it('lists users of a department in the caller tenant, paginated', async () => {
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', tenantId: 'tenant-1' });
    mockUserRepository.findAll.mockResolvedValue([{ id: 'ua' }, { id: 'ub' }]);
    mockUserRepository.count.mockResolvedValue(2);
    // `ua` is the primary/lead member; `ub` is not.
    mockUserDepartmentRepository.findAll.mockResolvedValue([{ userId: 'ua', isPrimary: true }]);

    const result = await service.getDepartmentUsers('dept-1', { page: 1, limit: 10 });

    expect(result.count).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);

    // `isLead` derived from the `isPrimary` membership set.
    const byId = Object.fromEntries(result.data.map((r) => [r.id, r]));
    expect(byId['ua'].isLead).toBe(true);
    expect(byId['ub'].isLead).toBe(false);

    const findAllArg = mockUserRepository.findAll.mock.calls[0][0] as {
      where: { UserDepartments: { some: Record<string, unknown> } };
    };
    expect(findAllArg.where.UserDepartments.some).toMatchObject({
      departmentId: 'dept-1',
      tenantId: 'tenant-1',
      resourceStatus: { not: ResourceStatusType.DELETED },
    });

    // The membership lookup is scoped to this department + tenant,
    // primary-only, and excludes soft-deleted rows.
    const udArg = mockUserDepartmentRepository.findAll.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(udArg.where).toMatchObject({
      departmentId: 'dept-1',
      tenantId: 'tenant-1',
      isPrimary: true,
      resourceStatus: { not: ResourceStatusType.DELETED },
    });
  });

  it('throws NotFound (no existence leak) for a cross-tenant department when not super-admin', async () => {
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-2', tenantId: 'tenant-OTHER' });

    await expect(service.getDepartmentUsers('dept-2', { page: 1, limit: 10 })).rejects.toThrow(NotFoundException);
    expect(mockUserRepository.findAll).not.toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN to read across tenants and scopes by the department tenant', async () => {
    clsUser = { id: 'sa', roles: ['SUPER_ADMIN'] };
    clsTenantId = null;
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-3', tenantId: 'tenant-x' });
    mockUserRepository.findAll.mockResolvedValue([{ id: 'z' }]);
    mockUserRepository.count.mockResolvedValue(1);
    mockUserDepartmentRepository.findAll.mockResolvedValue([]);

    const result = await service.getDepartmentUsers('dept-3', { page: 1, limit: 25 });

    expect(result.count).toBe(1);
    const findAllArg = mockUserRepository.findAll.mock.calls[0][0] as {
      where: { UserDepartments: { some: Record<string, unknown> } };
    };
    expect(findAllArg.where.UserDepartments.some).toMatchObject({ departmentId: 'dept-3', tenantId: 'tenant-x' });
  });

  it('throws NotFound when the department does not exist', async () => {
    mockDepartmentRepository.findById.mockResolvedValue(null);

    await expect(service.getDepartmentUsers('missing', { page: 1, limit: 10 })).rejects.toThrow(NotFoundException);
    expect(mockUserRepository.findAll).not.toHaveBeenCalled();
  });
});
