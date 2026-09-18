import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, StreamableFile } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { DataNotFoundException } from '@arcaai/exceptions';
import { UserController } from '../user.controller';

// Mirror of the AuditLogController CLS mock so the controller can read the
// caller's `user`/`tenantId` for tenant scoping.
function createMockCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null, tenantId?: string | null) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return tenantId ?? user?.tenantId ?? undefined;
      return undefined;
    }),
  };
}

const createMockUserService = () => ({
  create: vi.fn(),
  fetchAll: vi.fn(),
  fetchAllByTenantId: vi.fn(),
  fetchAllCreatedByUser: vi.fn(),
  fetchById: vi.fn(),
  fetchByExternalId: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
  // Export enrichment read-model; default = nothing enriched.
  getExportEnrichment: vi.fn().mockResolvedValue({}),
});

// Fake CASL ability for the bulk assign-role posture checks.
const abilityGranting = (granted: boolean) => ({
  can: vi.fn((action: string, subject: string) => (action === 'manage' && subject === 'UserRoleAssignment' ? granted : true)),
});

const createMockApiKeyService = () => ({
  fetchAll: vi.fn(),
  fetchAllByTenantId: vi.fn(),
  fetchAllByUserId: vi.fn(),
});

const createMockUserSettingsService = () => ({
  fetchAllByUserId: vi.fn(),
  upsertByUserKeyNamespace: vi.fn(),
});

const createMockUserRoleAssignmentService = () => ({
  create: vi.fn(),
  deleteById: vi.fn(),
  fetchAll: vi.fn(),
  fetchAllByUserId: vi.fn(),
  // The by-id tenant-scope guard resolves the target user's tenant
  // membership through this existing service method.
  findActiveTenantIdsForUser: vi.fn(),
});

// Admin user-profile + voice-profile read surfaces sit in the controller
// constructor (before the CLS arg). Mock them so the positional construction
// below matches the real 7-arg constructor.
const createMockUserProfileService = () => ({
  getByUserId: vi.fn(),
  upsertByUserId: vi.fn(),
});

const createMockVoiceProfileService = () => ({
  listByUserId: vi.fn(),
});

// The bulk department-reconcile dependency is injected before the CLS arg so
// the positional construction below matches the real 8-arg constructor.
const createMockUserDepartmentService = () => ({
  setDepartments: vi.fn(),
});

// Reset-password service, injected before the CLS arg (9-arg ctor).
const createMockUserPasswordService = () => ({
  setTemporaryPassword: vi.fn(),
  createResetLink: vi.fn(),
});

// Export serialization service, injected before the CLS arg (10-arg ctor).
const createMockUserExportService = () => ({
  build: vi.fn(),
});

const fakeUserEntity = {
  id: 'user-1',
  username: 'john_doe',
  lastLoginAt: new Date('2025-06-01T00:00:00Z'),
  lastActiveAt: new Date('2025-06-02T00:00:00Z'),
  externalId: 'ext-123',
  isServiceAccount: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'system',
  updatedBy: 'system',
  toObject: () => ({ id: 'user-1', username: 'john_doe' }),
};

const fakeFetchResponse = {
  data: [fakeUserEntity],
  count: 1,
  limit: 10,
  page: 1,
};

const fakeApiKeyEntity = {
  id: 'key-1',
  keyName: 'test-key',
  keyPrefix: 'hk_',
  keyType: 'STANDARD',
  keyStatus: 'ACTIVE',
  scopes: ['stt:transcription:read'],
  userId: 'user-1',
  tenantId: 'tenant-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  resourceStatus: 'ENABLED',
};

const fakeApiKeyFetchResponse = {
  data: [fakeApiKeyEntity],
  count: 1,
  limit: 10,
  page: 1,
};

const fakeUserRoleAssignmentEntity = {
  id: 'ura-1',
  userId: 'user-1',
  roleId: 'role-1',
  tenantId: 'tenant-1',
  createdBy: 'admin-1',
  updatedBy: null,
  createdAt: new Date('2026-01-29T10:00:00Z'),
  updatedAt: new Date('2026-01-29T10:00:00Z'),
  deletedAt: null,
  resourceStatus: 'ENABLED',
};

const fakeUserRoleAssignmentFetchResponse = {
  data: [fakeUserRoleAssignmentEntity],
  count: 1,
  limit: 10,
  page: 1,
};

describe('UserController', () => {
  let controller: UserController;
  let mockUserService: ReturnType<typeof createMockUserService>;
  let mockApiKeyService: ReturnType<typeof createMockApiKeyService>;
  let mockUserSettingsService: ReturnType<typeof createMockUserSettingsService>;
  let mockUserRoleAssignmentService: ReturnType<typeof createMockUserRoleAssignmentService>;
  let mockUserProfileService: ReturnType<typeof createMockUserProfileService>;
  let mockVoiceProfileService: ReturnType<typeof createMockVoiceProfileService>;
  let mockUserDepartmentService: ReturnType<typeof createMockUserDepartmentService>;
  let mockUserPasswordService: ReturnType<typeof createMockUserPasswordService>;
  let mockUserExportService: ReturnType<typeof createMockUserExportService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserService = createMockUserService();
    mockApiKeyService = createMockApiKeyService();
    mockUserSettingsService = createMockUserSettingsService();
    mockUserRoleAssignmentService = createMockUserRoleAssignmentService();
    mockUserProfileService = createMockUserProfileService();
    mockVoiceProfileService = createMockVoiceProfileService();
    mockUserDepartmentService = createMockUserDepartmentService();
    mockUserPasswordService = createMockUserPasswordService();
    mockUserExportService = createMockUserExportService();
    // Default to a SUPER_ADMIN context so the generic CRUD specs below
    // exercise the cross-tenant operator path (fetchAll). Tenant-scoping
    // specs construct their own per-case CLS mock.
    const mockCls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, null);
    controller = new UserController(
      mockUserService as any,
      mockApiKeyService as any,
      mockUserSettingsService as any,
      mockUserRoleAssignmentService as any,
      mockUserProfileService as any,
      mockVoiceProfileService as any,
      mockUserDepartmentService as any,
      mockUserPasswordService as any,
      mockUserExportService as any,
      mockCls as any,
    );
  });

  describe('POST /admin/users (create)', () => {
    it('should call userService.create with request body', async () => {
      const request = { username: 'new_user', password: 'pass123' };
      mockUserService.create.mockResolvedValue(fakeUserEntity);

      await controller.create(request as any);

      expect(mockUserService.create).toHaveBeenCalledWith(request);
      expect(mockUserService.create).toHaveBeenCalledTimes(1);
    });

    it('should return a mapped UserResponse', async () => {
      mockUserService.create.mockResolvedValue(fakeUserEntity);

      const result = await controller.create({ username: 'new_user', password: 'pass123' } as any);

      expect(result).toBeDefined();
      expect(result.username).toBe('john_doe');
    });
  });

  // PATCH /admin/users/:id/departments bulk-reconciles a user's memberships,
  // then returns the refreshed user (the SDK `assignDepartments` contract).
  // SUPER_ADMIN default context bypasses the per-id scope guard.
  describe('PATCH /admin/users/:id/departments (setDepartments — V2 bulk reconcile)', () => {
    it('reconciles departments via the service then returns the refreshed user', async () => {
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);
      const body = { departmentIds: ['dept-1', 'dept-2'], primaryDepartmentId: 'dept-1' };

      const result = await controller.setDepartments('user-1', body as any);

      expect(mockUserDepartmentService.setDepartments).toHaveBeenCalledWith('user-1', body);
      expect(mockUserService.fetchById).toHaveBeenCalledWith('user-1');
      expect(result.username).toBe('john_doe');
    });
  });

  describe('GET /admin/users (fetchAll)', () => {
    it('should call userService.fetchAll with query params', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

      await controller.fetchAll({ page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }));
    });

    it('should return paginated response', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

      const result = await controller.fetchAll({ page: 1, pageSize: 10 } as any);

      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Users list sort/filter/search via the shared PaginatedQuery. The CSV
  // filters/sort/search already flow through the
  // service → repository (withFormattedPaginatedProps → formatFindAllProps);
  // the controller adds a DETERMINISTIC default sort so server-side offset
  // paging from the admin grid is stable, mirroring AuditLogController.
  // The query params are otherwise forwarded untouched on every scoping branch.
  // -------------------------------------------------------------------------
  describe('sort/filter/search forwarding + default sort', () => {
    it('fetchAll: applies the default createdAt:desc sort when none is supplied (super-admin)', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

      await controller.fetchAll({ page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10, sort: 'createdAt:desc' }));
    });

    it('fetchAll: preserves an explicit sort and forwards filters/search untouched', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

      await controller.fetchAll({
        page: 1,
        pageSize: 25,
        sort: 'username:asc',
        filters: 'resourceStatus[equals]:ENABLED',
        search: 'john',
      } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: 'username:asc',
          filters: 'resourceStatus[equals]:ENABLED',
          search: 'john',
        }),
      );
    });

    it('fetchByTenant: applies the default sort and forwards the tenantId + query', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);

      await controller.fetchByTenant('tenant-1', { page: 1 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', page: 1, sort: 'createdAt:desc' }),
      );
    });

    it('fetchAll (non-super-admin): forwards default sort + filters to the tenant-scoped path', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['TENANT_ADMIN'] }, 't-OWN');
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await scoped.fetchAll({ page: 1, pageSize: 10, filters: 'isServiceAccount[equals]:false' } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't-OWN',
          sort: 'createdAt:desc',
          filters: 'isServiceAccount[equals]:false',
        }),
      );
      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/users tenant scoping: a TENANT_ADMIN with `manage:User` must
  // not be able to enumerate users platform-wide. Non-super-admins are
  // routed to the by-tenant service path; SUPER_ADMIN keeps cross-tenant.
  // -------------------------------------------------------------------------
  describe('GET /admin/users tenant scoping', () => {
    const buildController = (cls: ReturnType<typeof createMockCls>) =>
      new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

    it('routes a non-super-admin to fetchAllByTenantId scoped to the caller tenant', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['TENANT_ADMIN'] }, 't-OWN');

      await buildController(cls).fetchAll({ page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-OWN', page: 1, pageSize: 10 }));
      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
    });

    it('rejects a non-super-admin with NO tenant context (ForbiddenException, no enumeration)', async () => {
      const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['TENANT_ADMIN'] }, null);

      await expect(buildController(cls).fetchAll({} as any)).rejects.toBeInstanceOf(ForbiddenException);

      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
      expect(mockUserService.fetchAllByTenantId).not.toHaveBeenCalled();
    });

    it('lets a SUPER_ADMIN read cross-tenant via the unscoped fetchAll path', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, null);

      await buildController(cls).fetchAll({ page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledTimes(1);
      expect(mockUserService.fetchAllByTenantId).not.toHaveBeenCalled();
    });

    // When a SUPER_ADMIN selects a tenant in the console, the
    // ContextInterceptor elevates `x-tenant-id` into CLS `tenantId`.
    // `fetchAll` must honour it and scope the listing to that tenant instead
    // of silently enumerating every tenant.
    it('scopes a SUPER_ADMIN to the elevated CLS tenant (X-Tenant-Id) when present', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, 't-PICKED');

      await buildController(cls).fetchAll({ page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-PICKED', page: 1, pageSize: 10 }));
      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/users/:id (fetchById)', () => {
    it('should call userService.fetchById with correct id', async () => {
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);

      await controller.fetchById('user-1');

      expect(mockUserService.fetchById).toHaveBeenCalledWith('user-1');
      expect(mockUserService.fetchById).toHaveBeenCalledTimes(1);
    });

    it('should return a mapped UserResponse', async () => {
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);

      const result = await controller.fetchById('user-1');

      expect(result).toBeDefined();
      expect(result.username).toBe('john_doe');
    });
  });

  describe('GET /admin/users/tenant/:tenantId (fetchByTenant)', () => {
    it('should call userService.fetchAllByTenantId with tenantId and query params', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);

      await controller.fetchByTenant('tenant-1', { page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', page: 1, pageSize: 10 }));
    });

    it('should return paginated response', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);

      const result = await controller.fetchByTenant('tenant-1', { page: 1 } as any);

      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/users/tenant/:tenantId needs a caller-tenant guard, else any
  // `manage:User` holder (e.g. a TENANT_ADMIN) could enumerate ANY tenant's
  // users by UUID. Mirrors `fetchAll`'s tenant-scope guard: a non-super-admin
  // may only read their OWN tenant; SUPER_ADMIN keeps the cross-tenant read.
  // -------------------------------------------------------------------------
  describe('GET /admin/users/tenant/:tenantId caller-tenant guard', () => {
    const buildController = (cls: ReturnType<typeof createMockCls>) =>
      new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

    it('rejects a TENANT_ADMIN reading ANOTHER tenant (ForbiddenException, service untouched)', async () => {
      const cls = createMockCls({ id: 'u-1', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');

      await expect(buildController(cls).fetchByTenant('t-B', { page: 1 } as any)).rejects.toBeInstanceOf(ForbiddenException);

      expect(mockUserService.fetchAllByTenantId).not.toHaveBeenCalled();
    });

    it('lets a TENANT_ADMIN read their OWN tenant', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');

      await buildController(cls).fetchByTenant('t-A', { page: 1, pageSize: 10 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-A', page: 1, pageSize: 10 }));
    });

    it('lets a SUPER_ADMIN read ANY tenant cross-tenant', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, null);

      await buildController(cls).fetchByTenant('t-OTHER', { page: 1 } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-OTHER', page: 1 }));
    });
  });

  describe('PATCH /admin/users/:id (update)', () => {
    it('should call userService.update with id and request body', async () => {
      const request = { username: 'updated_user' };
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      await controller.update('user-1', request as any);

      expect(mockUserService.update).toHaveBeenCalledWith('user-1', request);
    });

    it('should return a mapped UserResponse', async () => {
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      const result = await controller.update('user-1', { username: 'updated' } as any);

      expect(result).toBeDefined();
      expect(result.username).toBe('john_doe');
    });
  });

  describe('PATCH /admin/users/:id/status (updateStatus)', () => {
    it('should call userService.update with id and resourceStatus', async () => {
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      await controller.updateStatus('user-1', { resourceStatus: 'DISABLED' } as any);

      expect(mockUserService.update).toHaveBeenCalledWith('user-1', { resourceStatus: 'DISABLED' });
    });
  });

  describe('DELETE /admin/users/:id (delete)', () => {
    it('should call userService.deleteById with correct id', async () => {
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      await controller.delete('user-1');

      expect(mockUserService.deleteById).toHaveBeenCalledWith('user-1');
      expect(mockUserService.deleteById).toHaveBeenCalledTimes(1);
    });

    it('should return a mapped UserResponse', async () => {
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      const result = await controller.delete('user-1');

      expect(result).toBeDefined();
    });
  });

  // ------------------------------------------------------------------------
  // bulkDelete partial-failure semantics.
  //
  // The loop catches per-id (rather than throwing on the first error) and
  // returns `{ succeeded: UserResponse[], failed: Array<{ id, reason }> }`
  // so partial failures are observable + idempotent retries are tractable.
  // ------------------------------------------------------------------------
  describe('DELETE /admin/users/bulk (bulkDelete)', () => {
    it('calls userService.deleteById once per id', async () => {
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      await controller.bulkDelete({ ids: ['user-1', 'user-2'] });

      expect(mockUserService.deleteById).toHaveBeenCalledTimes(2);
      expect(mockUserService.deleteById).toHaveBeenCalledWith('user-1');
      expect(mockUserService.deleteById).toHaveBeenCalledWith('user-2');
    });

    it('returns { succeeded: UserResponse[], failed: [] } when every id deletes cleanly', async () => {
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      const result = await controller.bulkDelete({ ids: ['user-1', 'user-2'] });

      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toEqual([]);
    });

    it('returns { succeeded: [], failed: [] } when no ids provided', async () => {
      const result = await controller.bulkDelete({ ids: [] });

      expect(result).toEqual({ succeeded: [], failed: [] });
      expect(mockUserService.deleteById).not.toHaveBeenCalled();
    });

    it('records the failing id under `failed` and KEEPS PROCESSING the rest (no early throw)', async () => {
      mockUserService.deleteById
        .mockResolvedValueOnce(fakeUserEntity)
        .mockRejectedValueOnce(new Error('row locked'))
        .mockResolvedValueOnce(fakeUserEntity);

      const result = await controller.bulkDelete({ ids: ['user-1', 'user-2', 'user-3'] });

      expect(mockUserService.deleteById).toHaveBeenCalledTimes(3);
      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toEqual([{ id: 'user-2', reason: 'row locked' }]);
    });

    it('captures all failures when every id fails — call never throws', async () => {
      mockUserService.deleteById.mockRejectedValue(new Error('downstream unavailable'));

      const result = await controller.bulkDelete({ ids: ['user-1', 'user-2'] });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([
        { id: 'user-1', reason: 'downstream unavailable' },
        { id: 'user-2', reason: 'downstream unavailable' },
      ]);
    });

    it('serialises non-Error throw values into a string reason (no [object Object] leaks)', async () => {
      mockUserService.deleteById.mockRejectedValueOnce('plain string reason');

      const result = await controller.bulkDelete({ ids: ['user-1'] });

      expect(result.failed).toEqual([{ id: 'user-1', reason: 'plain string reason' }]);
    });

    // ---------------------------------------------------------------------
    // TASK-986 R5 — route DECLARATION ORDER is load-bearing.
    //
    // Express registers routes in class-declaration order and `:id` matches
    // any literal segment, so while `delete(':id')` was declared FIRST,
    // `DELETE /admin/users/bulk` was captured by it and answered 404 "User not
    // found" for every caller — the handler below was unreachable over HTTP.
    // The sibling `@Get('export')` carries the same constraint and the same
    // comment.
    //
    // Every other test in this describe calls `bulkDelete` as a METHOD, which
    // bypasses routing entirely and is exactly why the suite stayed green
    // through the defect. This one pins the order; the HTTP proof lives in
    // `tests/e2e/task-986-users-bulk-and-export.spec.ts`.
    // ---------------------------------------------------------------------
    it('is DECLARED BEFORE the `/:id` delete so `DELETE /admin/users/bulk` is not shadowed', () => {
      const methods = Object.getOwnPropertyNames(UserController.prototype);
      expect(methods).toContain('bulkDelete');
      expect(methods).toContain('delete');
      expect(methods.indexOf('bulkDelete')).toBeLessThan(methods.indexOf('delete'));
    });
  });

  describe('POST /admin/users/:id/reset-password (resetPassword)', () => {
    it('mode="temporary": sets a temporary password and returns the plaintext', async () => {
      mockUserPasswordService.setTemporaryPassword.mockResolvedValue({ temporaryPassword: 'Temp1234' });

      const result = await controller.resetPassword('user-1', { mode: 'temporary' } as any);

      expect(mockUserPasswordService.setTemporaryPassword).toHaveBeenCalledWith('user-1', { temporaryPassword: undefined });
      expect(result).toEqual({ mode: 'temporary', temporaryPassword: 'Temp1234' });
      expect(mockUserPasswordService.createResetLink).not.toHaveBeenCalled();
    });

    it('mode="temporary": forwards an admin-supplied temporary password', async () => {
      mockUserPasswordService.setTemporaryPassword.mockResolvedValue({ temporaryPassword: 'ChosenPass1' });

      await controller.resetPassword('user-1', { mode: 'temporary', temporaryPassword: 'ChosenPass1' } as any);

      expect(mockUserPasswordService.setTemporaryPassword).toHaveBeenCalledWith('user-1', { temporaryPassword: 'ChosenPass1' });
    });

    it('mode="link" (default): mints a reset link and returns the token metadata', async () => {
      mockUserPasswordService.createResetLink.mockResolvedValue({
        token: 'tok',
        resetPath: '/reset-password?token=tok',
        expiresInSeconds: 3600,
        emailSent: true,
      });

      const result = await controller.resetPassword('user-1', {} as any);

      expect(mockUserPasswordService.createResetLink).toHaveBeenCalledWith('user-1');
      expect(result).toMatchObject({ mode: 'link', token: 'tok', emailSent: true, expiresInSeconds: 3600 });
      expect(mockUserPasswordService.setTemporaryPassword).not.toHaveBeenCalled();
    });

    it('enforces the by-id tenant-scope guard (cross-tenant target → 404, service untouched)', async () => {
      const cls = createMockCls({ id: 'admin-a', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await expect(scoped.resetPassword('victim', { mode: 'temporary' } as any)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUserPasswordService.setTemporaryPassword).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------
  // Replaces the client `Promise.allSettled` loop with one endpoint that
  // returns per-item success/failure. Action set: enable | disable | delete |
  // assign-departments | assign-role. Reuses the existing per-id scope guard.
  // ------------------------------------------------------------------------
  describe('POST /admin/users/bulk-actions (bulkActions)', () => {
    it('action="disable": updates each id to DISABLED, returns per-item results', async () => {
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      const result = await controller.bulkActions({ action: 'disable', ids: ['user-1', 'user-2'] } as any);

      expect(mockUserService.update).toHaveBeenCalledTimes(2);
      expect(mockUserService.update).toHaveBeenCalledWith('user-1', { resourceStatus: 'DISABLED' });
      expect(mockUserService.update).toHaveBeenCalledWith('user-2', { resourceStatus: 'DISABLED' });
      expect(result).toMatchObject({ action: 'disable', total: 2, succeeded: 2, failed: 0 });
      expect(result.results).toEqual([
        { id: 'user-1', success: true },
        { id: 'user-2', success: true },
      ]);
    });

    it('action="enable": updates each id to ENABLED', async () => {
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      await controller.bulkActions({ action: 'enable', ids: ['user-1'] } as any);

      expect(mockUserService.update).toHaveBeenCalledWith('user-1', { resourceStatus: 'ENABLED' });
    });

    it('action="delete": soft-deletes each id', async () => {
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      await controller.bulkActions({ action: 'delete', ids: ['user-1', 'user-2'] } as any);

      expect(mockUserService.deleteById).toHaveBeenCalledTimes(2);
      expect(mockUserService.deleteById).toHaveBeenCalledWith('user-1');
    });

    it('action="assign-departments": reconciles memberships per id with the shared payload', async () => {
      mockUserDepartmentService.setDepartments.mockResolvedValue(undefined);

      await controller.bulkActions({
        action: 'assign-departments',
        ids: ['user-1', 'user-2'],
        departmentIds: ['dept-1', 'dept-2'],
        primaryDepartmentId: 'dept-1',
      } as any);

      expect(mockUserDepartmentService.setDepartments).toHaveBeenCalledTimes(2);
      expect(mockUserDepartmentService.setDepartments).toHaveBeenCalledWith('user-1', {
        departmentIds: ['dept-1', 'dept-2'],
        primaryDepartmentId: 'dept-1',
      });
    });

    it('records per-item failure and KEEPS PROCESSING the rest (no early throw)', async () => {
      mockUserService.update
        .mockResolvedValueOnce(fakeUserEntity)
        .mockRejectedValueOnce(new Error('row locked'))
        .mockResolvedValueOnce(fakeUserEntity);

      const result = await controller.bulkActions({ action: 'disable', ids: ['user-1', 'user-2', 'user-3'] } as any);

      expect(mockUserService.update).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
      expect(result.results).toContainEqual({ id: 'user-2', success: false, error: 'row locked' });
    });

    it('returns empty aggregate when no ids provided (service untouched)', async () => {
      const result = await controller.bulkActions({ action: 'disable', ids: [] } as any);

      expect(result).toMatchObject({ action: 'disable', total: 0, succeeded: 0, failed: 0 });
      expect(result.results).toEqual([]);
      expect(mockUserService.update).not.toHaveBeenCalled();
    });

    it('validates EVERY id — a cross-tenant id is recorded as failed and is NOT mutated', async () => {
      const cls = createMockCls({ id: 'admin-a', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockImplementation((id: string) =>
        id === 'mine' ? Promise.resolve(['t-A']) : Promise.resolve(['t-B']),
      );
      mockUserService.update.mockResolvedValue(fakeUserEntity);
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      const result = await scoped.bulkActions({ action: 'disable', ids: ['mine', 'theirs'] } as any);

      expect(mockUserService.update).toHaveBeenCalledTimes(1);
      expect(mockUserService.update).toHaveBeenCalledWith('mine', { resourceStatus: 'DISABLED' });
      expect(result).toMatchObject({ succeeded: 1, failed: 1 });
      expect(result.results).toContainEqual(expect.objectContaining({ id: 'theirs', success: false }));
    });
  });

  // ------------------------------------------------------------------------
  // The `assign-role` bulk arm mirrors the single-user `POST :id/roles`
  // semantics: same service (`create` enforces the tier/tenant guards per
  // item) and the SAME CASL posture — the arm requires
  // `manage:UserRoleAssignment` (checked imperatively via the request
  // ability, since the class-level gate is only `manage:User`).
  // ------------------------------------------------------------------------
  describe('POST /admin/users/bulk-actions action="assign-role"', () => {
    it('assigns the role to every id via userRoleAssignmentService.create, per-item envelope', async () => {
      mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);

      const result = await controller.bulkActions(
        { action: 'assign-role', ids: ['user-1', 'user-2'], roleId: 'role-9' } as any,
        abilityGranting(true) as any,
      );

      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledTimes(2);
      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith({ roleId: 'role-9', userId: 'user-1' });
      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith({ roleId: 'role-9', userId: 'user-2' });
      expect(result).toMatchObject({ action: 'assign-role', total: 2, succeeded: 2, failed: 0 });
    });

    it('rejects a caller WITHOUT manage:UserRoleAssignment with 403 before any mutation (AC-02 posture)', async () => {
      await expect(
        controller.bulkActions({ action: 'assign-role', ids: ['user-1'], roleId: 'role-9' } as any, abilityGranting(false) as any),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(mockUserRoleAssignmentService.create).not.toHaveBeenCalled();
    });

    it('rejects a missing roleId with 400 before any mutation', async () => {
      await expect(controller.bulkActions({ action: 'assign-role', ids: ['user-1'] } as any, abilityGranting(true) as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mockUserRoleAssignmentService.create).not.toHaveBeenCalled();
    });

    it('does NOT apply the UserRoleAssignment posture to the other arms (disable works without it)', async () => {
      mockUserService.update.mockResolvedValue(fakeUserEntity);

      const result = await controller.bulkActions({ action: 'disable', ids: ['user-1'] } as any, abilityGranting(false) as any);

      expect(result).toMatchObject({ action: 'disable', succeeded: 1 });
    });

    it('records a per-item service failure (e.g. AC-02 tier guard) and keeps processing', async () => {
      mockUserRoleAssignmentService.create
        .mockRejectedValueOnce(new Error('Only a SUPER_ADMIN may assign the SUPER_ADMIN role'))
        .mockResolvedValueOnce(fakeUserRoleAssignmentEntity);

      const result = await controller.bulkActions(
        { action: 'assign-role', ids: ['user-1', 'user-2'], roleId: 'role-sa' } as any,
        abilityGranting(true) as any,
      );

      expect(result).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
      expect(result.results).toContainEqual({
        id: 'user-1',
        success: false,
        error: 'Only a SUPER_ADMIN may assign the SUPER_ADMIN role',
      });
    });

    it('validates EVERY id — a cross-tenant target is recorded failed and never reaches the service', async () => {
      const cls = createMockCls({ id: 'admin-a', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockImplementation((id: string) =>
        id === 'mine' ? Promise.resolve(['t-A']) : Promise.resolve(['t-B']),
      );
      mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      const result = await scoped.bulkActions(
        { action: 'assign-role', ids: ['mine', 'theirs'], roleId: 'role-9' } as any,
        abilityGranting(true) as any,
      );

      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledTimes(1);
      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith({ roleId: 'role-9', userId: 'mine' });
      expect(result).toMatchObject({ succeeded: 1, failed: 1 });
      expect(result.results).toContainEqual(expect.objectContaining({ id: 'theirs', success: false }));
    });
  });

  describe('GET /admin/users/export (exportUsers)', () => {
    const fakeFile = { buffer: Buffer.from('data'), contentType: 'text/csv; charset=utf-8', filename: 'users.csv' };

    it('materialises the scoped set and delegates serialization, returning a StreamableFile', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      const result = await controller.exportUsers({ format: 'csv' } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 10000, sort: 'createdAt:desc' }));
      expect(mockUserExportService.build).toHaveBeenCalledWith('csv', [
        { id: 'user-1', username: 'john_doe', email: '', type: 'User', status: 'ENABLED', departments: '' },
      ]);
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('enriches rows with email + department names via ONE batched getExportEnrichment call', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserService.getExportEnrichment.mockResolvedValue({
        'user-1': { email: 'john@example.com', departmentNames: ['Cardiology', 'Radiology'] },
      });
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({ format: 'csv' } as any);

      // ONE call carrying the FULL id set (the no-N+1 contract at this layer).
      expect(mockUserService.getExportEnrichment).toHaveBeenCalledTimes(1);
      expect(mockUserService.getExportEnrichment).toHaveBeenCalledWith(['user-1'], undefined);
      expect(mockUserExportService.build).toHaveBeenCalledWith('csv', [
        {
          id: 'user-1',
          username: 'john_doe',
          email: 'john@example.com',
          type: 'User',
          status: 'ENABLED',
          departments: 'Cardiology, Radiology',
        },
      ]);
    });

    it('threads the caller tenant into the enrichment (tenant-scoped export)', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await scoped.exportUsers({ format: 'csv' } as any);

      expect(mockUserService.getExportEnrichment).toHaveBeenCalledWith(['user-1'], 't-A');
    });

    it('defaults the format to csv when none is supplied', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({} as any);

      expect(mockUserExportService.build).toHaveBeenCalledWith('csv', expect.any(Array));
    });

    it('forwards format=xlsx to the export service', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue({ ...fakeFile, filename: 'users.xlsx' });

      await controller.exportUsers({ format: 'xlsx' } as any);

      expect(mockUserExportService.build).toHaveBeenCalledWith('xlsx', expect.any(Array));
    });

    it('scopes a non-super-admin export to the caller tenant (never cross-tenant)', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await scoped.exportUsers({ format: 'csv' } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-A', limit: 10000 }));
      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
    });

    it('rejects a non-super-admin with NO tenant context (ForbiddenException, nothing serialized)', async () => {
      const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['TENANT_ADMIN'] }, null);
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await expect(scoped.exportUsers({ format: 'csv' } as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockUserExportService.build).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // TASK-986 R6 — selection-scoped export (`ids`).
    //
    // The id set NARROWS the SAME tenant-scoped query the unscoped export
    // already runs; it never becomes a by-id fetch. That is the whole security
    // argument: a caller cannot reach a row by naming it, because the branch
    // that chooses `fetchAll` vs `fetchAllByTenantId` runs FIRST and unchanged,
    // and the id set only ever rides along as an extra `filters` token.
    // -----------------------------------------------------------------------
    it('scopes the export to the named ids via an id[in] filter token', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({ format: 'csv', ids: ['user-1', 'user-2'] } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ filters: 'id[in]:user-1|user-2' }));
    });

    it('ANDs the id filter onto the caller own CSV filters (never replaces them)', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({ format: 'csv', filters: 'resourceStatus[equals]:ENABLED', ids: ['user-1'] } as any);

      expect(mockUserService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ filters: 'resourceStatus[equals]:ENABLED;id[in]:user-1' }));
    });

    it('leaves the query untouched when ids is absent or empty (full-view export)', async () => {
      mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({ format: 'csv', ids: [] } as any);

      const [params] = mockUserService.fetchAll.mock.calls[0] as [Record<string, unknown>];
      expect(params.filters).toBeUndefined();
      expect(params.ids).toBeUndefined();
    });

    it('a named CROSS-TENANT id is never exported: the id set rides the caller tenant-scoped query', async () => {
      // The service answers what the DB would: only the caller own-tenant row.
      // `theirs-1` is named by the caller and simply is not in the scoped set.
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);
      const cls = createMockCls({ id: 'u-1', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');
      const scoped = new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

      await scoped.exportUsers({ format: 'csv', ids: ['user-1', 'theirs-1'] } as any);

      // Still the tenant-scoped read — naming ids does NOT unlock the
      // cross-tenant `fetchAll`, and never becomes a by-id lookup.
      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't-A', filters: 'id[in]:user-1|theirs-1' }),
      );
      expect(mockUserService.fetchAll).not.toHaveBeenCalled();
      expect(mockUserService.fetchById).not.toHaveBeenCalled();
      // The foreign id is absent from the serialized rows.
      const [, rows] = mockUserExportService.build.mock.calls[0] as [string, Array<{ id: string }>];
      expect(rows.map((r) => r.id)).toEqual(['user-1']);
    });

    it('honours an explicit tenantId scope alongside ids (same assertCanReadTenant guard)', async () => {
      mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);
      mockUserExportService.build.mockResolvedValue(fakeFile);

      await controller.exportUsers({ format: 'csv', tenantId: 't-B', ids: ['user-1'] } as any);

      expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-B', filters: 'id[in]:user-1' }));
    });
  });

  describe('GET /admin/users/:id/roles (fetchUserRoleAssignments)', () => {
    it('should call userRoleAssignmentService.fetchAllByUserId with userId and query params', async () => {
      mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

      await controller.fetchUserRoleAssignments('user-1', { page: 1, pageSize: 10 } as any);

      expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 10, userId: 'user-1' }),
      );
      expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledTimes(1);
    });

    it('should return a paginated UserRoleAssignmentResponse mapped from service result', async () => {
      mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

      const result = await controller.fetchUserRoleAssignments('user-1', { page: 1, pageSize: 10 } as any);

      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].userId).toBe('user-1');
      expect(result.data[0].roleId).toBe('role-1');
      expect(result.count).toBe(1);
    });

    it('should NOT call fetchAll (which ignores userId)', async () => {
      mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

      await controller.fetchUserRoleAssignments('user-1', { page: 1 } as any);

      expect(mockUserRoleAssignmentService.fetchAll).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/users/:id/roles (assignRole)', () => {
    it('should call userRoleAssignmentService.create with body merged with userId', async () => {
      const body = { roleId: 'role-1' };
      mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);

      await controller.assignRole('user-1', body as any);

      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith({ roleId: 'role-1', userId: 'user-1' });
      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledTimes(1);
    });

    it('should return a mapped UserRoleAssignmentResponse', async () => {
      mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);

      const result = await controller.assignRole('user-1', { roleId: 'role-1' } as any);

      expect(result).toBeDefined();
      expect(result.userId).toBe('user-1');
      expect(result.roleId).toBe('role-1');
    });

    it('should propagate errors thrown by the service', async () => {
      mockUserRoleAssignmentService.create.mockRejectedValue(new Error('Conflict'));

      await expect(controller.assignRole('user-1', { roleId: 'role-1' } as any)).rejects.toThrow('Conflict');
    });
  });

  describe('DELETE /admin/users/:id/roles/:assignmentId (removeRole)', () => {
    it('should call userRoleAssignmentService.deleteById with assignmentId', async () => {
      mockUserRoleAssignmentService.deleteById.mockResolvedValue(undefined);

      await controller.removeRole('assignment-1');

      expect(mockUserRoleAssignmentService.deleteById).toHaveBeenCalledWith('assignment-1');
      expect(mockUserRoleAssignmentService.deleteById).toHaveBeenCalledTimes(1);
    });

    it('should return void (no response body)', async () => {
      mockUserRoleAssignmentService.deleteById.mockResolvedValue(undefined);

      const result = await controller.removeRole('assignment-1');

      expect(result).toBeUndefined();
    });
  });

  describe('GET /admin/users/:id/api-keys (fetchUserApiKeys)', () => {
    it('should call apiKeyService.fetchAllByUserId with userId', async () => {
      mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

      await controller.fetchUserApiKeys('user-1', { page: 1, pageSize: 10 } as any);

      expect(mockApiKeyService.fetchAllByUserId).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10, userId: 'user-1' }));
    });

    it('should NOT call fetchAll (which ignores userId)', async () => {
      mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

      await controller.fetchUserApiKeys('user-1', { page: 1 } as any);

      expect(mockApiKeyService.fetchAll).not.toHaveBeenCalled();
    });

    it('should return paginated API key response', async () => {
      mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

      const result = await controller.fetchUserApiKeys('user-1', { page: 1 } as any);

      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // The by-id User routes require a caller-tenant guard.
  // The `User` model is intentionally NOT tenant-scoped at the Prisma
  // extension level, so a TENANT_ADMIN with `manage:User` could read/mutate
  // ANY tenant's user by UUID. The fix resolves the TARGET user's tenant
  // membership (via UserRoleAssignment) and throws 404 (no existence leak)
  // when the target is outside the caller's active tenant. SUPER_ADMIN is
  // platform-wide and exempt.
  // -------------------------------------------------------------------------
  describe('AC-01 — by-id tenant-scope guard (cross-tenant User IDOR)', () => {
    const buildController = (cls: ReturnType<typeof createMockCls>) =>
      new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

    const tenantAdmin = () => createMockCls({ id: 'admin-a', tenantId: 't-A', roles: ['TENANT_ADMIN'] }, 't-A');

    it('fetchById: rejects a TENANT_ADMIN reading a user in ANOTHER tenant with 404 (service untouched)', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);

      await expect(buildController(tenantAdmin()).fetchById('victim')).rejects.toBeInstanceOf(NotFoundException);

      expect(mockUserRoleAssignmentService.findActiveTenantIdsForUser).toHaveBeenCalledWith('victim');
      expect(mockUserService.fetchById).not.toHaveBeenCalled();
    });

    it('fetchById: allows a TENANT_ADMIN reading a user in their OWN tenant', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-A']);
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);

      await buildController(tenantAdmin()).fetchById('member');

      expect(mockUserService.fetchById).toHaveBeenCalledWith('member');
    });

    it('fetchById: SUPER_ADMIN bypasses the scope check (cross-tenant read, membership never resolved)', async () => {
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);
      const cls = createMockCls({ id: 'root', tenantId: null, roles: ['SUPER_ADMIN'] }, null);

      await buildController(cls).fetchById('anyone');

      expect(mockUserService.fetchById).toHaveBeenCalledWith('anyone');
      expect(mockUserRoleAssignmentService.findActiveTenantIdsForUser).not.toHaveBeenCalled();
    });

    it('update: rejects a cross-tenant target with 404 (service untouched)', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);

      await expect(buildController(tenantAdmin()).update('victim', { username: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);

      expect(mockUserService.update).not.toHaveBeenCalled();
    });

    it('updateStatus: rejects a cross-tenant target with 404 (service untouched)', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);

      await expect(buildController(tenantAdmin()).updateStatus('victim', { resourceStatus: 'DISABLED' } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(mockUserService.update).not.toHaveBeenCalled();
    });

    it('delete: rejects a cross-tenant target with 404 (service untouched)', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);

      await expect(buildController(tenantAdmin()).delete('victim')).rejects.toBeInstanceOf(NotFoundException);

      expect(mockUserService.deleteById).not.toHaveBeenCalled();
    });

    it('fetchUserSettings: rejects a cross-tenant target with 404 (service untouched)', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockResolvedValue(['t-B']);

      await expect(buildController(tenantAdmin()).fetchUserSettings('victim')).rejects.toBeInstanceOf(NotFoundException);

      expect(mockUserSettingsService.fetchAllByUserId).not.toHaveBeenCalled();
    });

    it('rejects a non-super-admin with NO tenant context with 404 (no enumeration)', async () => {
      const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['TENANT_ADMIN'] }, null);

      await expect(buildController(cls).fetchById('victim')).rejects.toBeInstanceOf(NotFoundException);

      expect(mockUserService.fetchById).not.toHaveBeenCalled();
    });

    it('bulkDelete: validates EVERY id — a cross-tenant id is recorded as failed and is NOT deleted', async () => {
      mockUserRoleAssignmentService.findActiveTenantIdsForUser.mockImplementation((id: string) =>
        id === 'mine' ? Promise.resolve(['t-A']) : Promise.resolve(['t-B']),
      );
      mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

      const result = await buildController(tenantAdmin()).bulkDelete({ ids: ['mine', 'theirs'] });

      expect(mockUserService.deleteById).toHaveBeenCalledTimes(1);
      expect(mockUserService.deleteById).toHaveBeenCalledWith('mine');
      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe('theirs');
    });
  });

  // -------------------------------------------------------------------------
  // F-07: sub-collection routes (`:id/roles`, `:id/api-keys`, `:id/settings`,
  // `:id/profile`, `:id/voice-profiles`) answered `200` with an empty
  // collection for a NONEXISTENT parent user id, because the only existence
  // signal (`findActiveTenantIdsForUser` returning an empty tenant list) is
  // never reached by a SUPER_ADMIN caller — that branch returns immediately.
  // `assertUserInScope` now proves existence via `userService.fetchById`
  // FIRST, for every caller including SUPER_ADMIN.
  // -------------------------------------------------------------------------
  describe('F-07 — SUPER_ADMIN existence guard on sub-collection routes', () => {
    const buildController = (cls: ReturnType<typeof createMockCls>) =>
      new UserController(
        mockUserService as any,
        mockApiKeyService as any,
        mockUserSettingsService as any,
        mockUserRoleAssignmentService as any,
        mockUserProfileService as any,
        mockVoiceProfileService as any,
        mockUserDepartmentService as any,
        mockUserPasswordService as any,
        mockUserExportService as any,
        cls as any,
      );

    const superAdmin = () => createMockCls({ id: 'root', tenantId: null, roles: ['SUPER_ADMIN'] }, null);

    beforeEach(() => {
      mockUserService.fetchById.mockRejectedValue(new DataNotFoundException('User', 'bogus-id'));
    });

    it('fetchUserRoleAssignments: 404s a bogus id for a SUPER_ADMIN caller (never 200 [])', async () => {
      await expect(buildController(superAdmin()).fetchUserRoleAssignments('bogus-id', { page: 1, pageSize: 10 } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockUserRoleAssignmentService.fetchAllByUserId).not.toHaveBeenCalled();
    });

    it('fetchUserApiKeys: 404s a bogus id for a SUPER_ADMIN caller (never 200 [])', async () => {
      await expect(buildController(superAdmin()).fetchUserApiKeys('bogus-id', { page: 1, pageSize: 10 } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockApiKeyService.fetchAllByUserId).not.toHaveBeenCalled();
    });

    it('fetchUserSettings: 404s a bogus id for a SUPER_ADMIN caller (never 200 [])', async () => {
      await expect(buildController(superAdmin()).fetchUserSettings('bogus-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUserSettingsService.fetchAllByUserId).not.toHaveBeenCalled();
    });

    it('fetchUserProfile: 404s a bogus id for a SUPER_ADMIN caller (never 200 null)', async () => {
      await expect(buildController(superAdmin()).fetchUserProfile('bogus-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockUserProfileService.getByUserId).not.toHaveBeenCalled();
    });

    it('fetchUserVoiceProfiles: 404s a bogus id for a SUPER_ADMIN caller (never 200 [])', async () => {
      await expect(buildController(superAdmin()).fetchUserVoiceProfiles('bogus-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockVoiceProfileService.listByUserId).not.toHaveBeenCalled();
    });

    it('a real id for the SAME checks still succeeds (existence proven, not just gated)', async () => {
      mockUserService.fetchById.mockResolvedValue(fakeUserEntity);
      mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue({ data: [], count: 0, page: 1, limit: 10 });

      const result = await buildController(superAdmin()).fetchUserRoleAssignments('real-id', { page: 1, pageSize: 10 } as any);

      expect(result).toBeDefined();
      expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledWith(expect.objectContaining({ userId: 'real-id' }));
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/users/:id/roles must not rely on only the class-level
  // `@CanManage('User')`. A role-assignment
  // route must carry the permission that governs the resource it mutates:
  // `manage:UserRoleAssignment` (matches the `rbac-*` policy seed). The
  // method-level decorator overrides the class-level one via
  // `Reflector.getAllAndOverride([handler, class])`.
  // -------------------------------------------------------------------------
  describe('AC-02 — assignRole route permission', () => {
    it('assignRole carries manage:UserRoleAssignment (overrides the class-level manage:User)', () => {
      const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, UserController.prototype.assignRole);
      expect(required).toEqual([{ action: 'manage', subject: 'UserRoleAssignment' }]);
    });
  });
});

describe('UserController - OpenAPI/Swagger metadata', () => {
  const SWAGGER = {
    API_OPERATION: 'swagger/apiOperation',
    API_RESPONSE: 'swagger/apiResponse',
    API_PARAMETERS: 'swagger/apiParameters',
    API_SECURITY: 'swagger/apiSecurity',
    API_TAGS: 'swagger/apiUseTags',
  };

  function getMethodMetadata(key: string, method: string) {
    return Reflect.getMetadata(key, UserController.prototype[method]);
  }

  describe('class-level decorators', () => {
    it('should have @ApiTags("admin-users")', () => {
      const tags = Reflect.getMetadata(SWAGGER.API_TAGS, UserController);
      expect(tags).toContain('admin-users');
    });

    it('should have @ApiBearerAuth()', () => {
      const security = Reflect.getMetadata(SWAGGER.API_SECURITY, UserController);
      expect(security).toBeDefined();
      expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
    });
  });

  describe('create', () => {
    it('should have @ApiOperation with summary', () => {
      const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'create');
      expect(metadata).toBeDefined();
      expect(metadata.summary).toBeDefined();
    });

    it('should have @ApiResponse for 400 (bad request)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'create');
      expect(responses).toBeDefined();
      expect(responses[400]).toBeDefined();
    });
  });

  describe('fetchAll', () => {
    it('should have @ApiOperation with summary', () => {
      const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'fetchAll');
      expect(metadata).toBeDefined();
      expect(metadata.summary).toBeDefined();
    });

    it('should have @ApiQuery parameters for pagination', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchAll');
      expect(params).toBeDefined();
      const queryParams = params.filter((p: any) => p.in === 'query');
      const names = queryParams.map((p: any) => p.name);
      expect(names).toEqual(expect.arrayContaining(['page', 'pageSize']));
    });
  });

  describe('fetchById', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchById');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchById');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('fetchByTenant', () => {
    it('should have @ApiParam for tenantId', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchByTenant');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('tenantId');
    });
  });

  describe('update', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'update');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'update');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'delete');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'delete');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('fetchUserApiKeys', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchUserApiKeys');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });
  });
});
