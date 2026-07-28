/**
 * Export enrichment read-model.
 *
 * `UserService.getExportEnrichment(userIds, tenantId?)` batch-resolves, for the
 * whole export set, the profile `email` + active department NAMES so the users
 * export can render human-readable columns. The contract under test:
 *
 *   - NO N+1: exactly ONE `userProfile.findMany` + ONE `userDepartment.findMany`
 *     (with the `Department.name` join) for ANY number of ids.
 *   - In-memory join keyed by userId; a user with no profile/memberships still
 *     resolves (email '' / no names) so the export row count never shrinks.
 *   - When a tenant context is supplied, membership rows are filtered to that
 *     tenant (a tenant-scoped export never leaks other-tenant department names);
 *     without one (cross-tenant super-admin export) no tenant filter is applied.
 *   - Empty input short-circuits without touching the database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { UserService } from '../user.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { findAll: vi.fn(), count: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };
const mockUserProfileService = { upsertByUserId: vi.fn() };

const profileFindMany = vi.fn();
const departmentFindMany = vi.fn();
const mockDatabaseService = {
  baseClient: {
    userProfile: { findMany: profileFindMany },
    userDepartment: { findMany: departmentFindMany },
  },
};
// Constructor now takes crypto + appSettings (unused by enrichment).
const mockCryptoService = { hash: vi.fn(), verify: vi.fn() };
const mockAppSettings = { getValueWithDefault: vi.fn(<T>(_key: string, defaultValue: T): T => defaultValue) };

function buildService() {
  return new UserService(
    mockUserRepository as any,
    mockUserRoleAssignmentRepository as any,
    mockUserDepartmentRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockDatabaseService as any,
    mockUserProfileService as any,
    mockCryptoService as any,
    mockAppSettings as any,
  );
}

describe('UserService — getExportEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockReturnValue(null);
    profileFindMany.mockResolvedValue([]);
    departmentFindMany.mockResolvedValue([]);
  });

  it('batch-fetches with exactly ONE grouped query per model (no N+1) and joins in memory', async () => {
    profileFindMany.mockResolvedValue([
      { userId: 'u-1', email: 'a@example.com' },
      { userId: 'u-2', email: 'b@example.com' },
    ]);
    departmentFindMany.mockResolvedValue([
      { userId: 'u-1', isPrimary: true, Department: { name: 'Cardiology' } },
      { userId: 'u-1', isPrimary: false, Department: { name: 'Radiology' } },
      { userId: 'u-2', isPrimary: false, Department: { name: 'General Practice' } },
    ]);

    const result = await buildService().getExportEnrichment(['u-1', 'u-2', 'u-3']);

    // The no-N+1 shape: one findMany per model, each carrying the FULL id set.
    expect(profileFindMany).toHaveBeenCalledTimes(1);
    expect(departmentFindMany).toHaveBeenCalledTimes(1);
    expect(profileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['u-1', 'u-2', 'u-3'] } }) }),
    );
    expect(departmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['u-1', 'u-2', 'u-3'] } }) }),
    );

    expect(result['u-1']).toEqual({ email: 'a@example.com', departmentNames: ['Cardiology', 'Radiology'] });
    expect(result['u-2']).toEqual({ email: 'b@example.com', departmentNames: ['General Practice'] });
    // u-3 has neither a profile nor memberships — still resolvable, empty.
    expect(result['u-3']).toEqual({ email: '', departmentNames: [] });
  });

  it('only ENABLED memberships contribute department names', async () => {
    await buildService().getExportEnrichment(['u-1']);

    expect(departmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
      }),
    );
  });

  it('scopes membership rows to the supplied tenant (tenant-scoped export)', async () => {
    await buildService().getExportEnrichment(['u-1'], 't-A');

    expect(departmentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 't-A' }) }));
  });

  it('applies NO tenant filter when none is supplied (cross-tenant super-admin export)', async () => {
    await buildService().getExportEnrichment(['u-1']);

    const where = departmentFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect('tenantId' in where).toBe(false);
  });

  it('short-circuits on an empty id set without touching the database', async () => {
    const result = await buildService().getExportEnrichment([]);

    expect(result).toEqual({});
    expect(profileFindMany).not.toHaveBeenCalled();
    expect(departmentFindMany).not.toHaveBeenCalled();
  });

  it('a null profile email degrades to an empty string', async () => {
    profileFindMany.mockResolvedValue([{ userId: 'u-1', email: null }]);

    const result = await buildService().getExportEnrichment(['u-1']);

    expect(result['u-1'].email).toBe('');
  });
});
