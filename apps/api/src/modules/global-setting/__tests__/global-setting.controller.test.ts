import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { GlobalSettingController } from '../global-setting.controller';

// The real GlobalSettingDtoMapper.ToResponse (AutoClassMapper) runs against
// these plain fixtures — so they carry every GlobalSettingResponse field.
const fakeEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'gs-1',
  name: 'Feature Flag',
  description: 'A platform flag',
  key: 'feature.enable',
  value: 'true',
  dataType: 'Boolean',
  namespace: 'features',
  tenantId: null,
  version: 3,
  locked: false,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  createdBy: 'system',
  updatedBy: null,
  resourceStatus: 'ENABLED',
  ...overrides,
});

const createMockService = () => ({
  create: vi.fn(),
  fetchAll: vi.fn(),
  fetchAllByTenantId: vi.fn(),
  fetchById: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
  revealSecret: vi.fn(),
});

const createMockCls = () => ({ get: vi.fn() });

describe('GlobalSettingController', () => {
  let controller: GlobalSettingController;
  let mockService: ReturnType<typeof createMockService>;
  let mockCls: ReturnType<typeof createMockCls>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockService();
    mockCls = createMockCls();
    controller = new GlobalSettingController(mockService as any, mockCls as any);
  });

  describe('POST /admin/settings (create)', () => {
    it('delegates to service.create and maps the entity to a response', async () => {
      mockService.create.mockResolvedValue(fakeEntity());

      const result = await controller.create({ name: 'Feature Flag', key: 'feature.enable', value: 'true', dataType: 'Boolean' } as any);

      expect(mockService.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('gs-1');
      expect(result.key).toBe('feature.enable');
      expect(result.version).toBe(3);
    });
  });

  describe('GET /admin/settings (fetchAll)', () => {
    it('uses fetchAllByTenantId when a tenant is in context', async () => {
      mockCls.get.mockReturnValue('tenant-1');
      mockService.fetchAllByTenantId.mockResolvedValue({ page: 1, limit: 20, count: 1, data: [fakeEntity()] });

      const result = await controller.fetchAll({ page: 1, limit: 20 } as any);

      expect(mockService.fetchAllByTenantId).toHaveBeenCalledWith({ page: 1, limit: 20, tenantId: 'tenant-1' });
      expect(mockService.fetchAll).not.toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
    });

    it('uses the unscoped fetchAll when no tenant is in context (platform caller)', async () => {
      mockCls.get.mockReturnValue(undefined);
      mockService.fetchAll.mockResolvedValue({ page: 1, limit: 20, count: 0, data: [] });

      await controller.fetchAll({ page: 1, limit: 20 } as any);

      expect(mockService.fetchAll).toHaveBeenCalledTimes(1);
      expect(mockService.fetchAllByTenantId).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/settings/tenant/:tenantId (fetchByTenant)', () => {
    it('delegates to fetchAllByTenantId with the path tenantId', async () => {
      mockService.fetchAllByTenantId.mockResolvedValue({ page: 1, limit: 20, count: 0, data: [] });

      await controller.fetchByTenant('tenant-9', { page: 1, limit: 20 } as any);

      expect(mockService.fetchAllByTenantId).toHaveBeenCalledWith({ page: 1, limit: 20, tenantId: 'tenant-9' });
    });
  });

  describe('GET /admin/settings/:id (fetchById)', () => {
    it('delegates to service.fetchById and maps the response', async () => {
      mockService.fetchById.mockResolvedValue(fakeEntity({ id: 'gs-9' }));

      const result = await controller.fetchById('gs-9');

      expect(mockService.fetchById).toHaveBeenCalledWith('gs-9');
      expect(result.id).toBe('gs-9');
    });
  });

  describe('PATCH /admin/settings/:id (update, OCC)', () => {
    it('folds the If-Match header version over the body expectedVersion', async () => {
      mockService.update.mockResolvedValue(fakeEntity({ value: 'false', version: 4 }));

      const result = await controller.update('gs-1', { value: 'false' } as any, 3);

      expect(mockService.update).toHaveBeenCalledWith('gs-1', { value: 'false', expectedVersion: 3 });
      expect(result.version).toBe(4);
    });

    it('passes the body through unchanged when no header version is present', async () => {
      mockService.update.mockResolvedValue(fakeEntity());

      await controller.update('gs-1', { value: 'x', expectedVersion: 2 } as any, undefined);

      expect(mockService.update).toHaveBeenCalledWith('gs-1', { value: 'x', expectedVersion: 2 });
    });
  });

  describe('DELETE /admin/settings/:id (delete → softDelete)', () => {
    it('delegates to service.deleteById (domain soft delete)', async () => {
      mockService.deleteById.mockResolvedValue(fakeEntity({ resourceStatus: 'DELETED' }));

      const result = await controller.delete('gs-1');

      expect(mockService.deleteById).toHaveBeenCalledWith('gs-1');
      expect(result.id).toBe('gs-1');
    });
  });

  // TASK-396 — reveal ONE secret. Global-admin-only (CASL) + step-up re-auth.
  describe('POST /admin/settings/:id/reveal (reveal)', () => {
    it('delegates to service.revealSecret with the id + step-up password and returns the plaintext', async () => {
      mockService.revealSecret.mockResolvedValue({ entity: fakeEntity({ id: 'gs-7', key: 'secrets.api-token' }), plaintext: 'plaintext-secret' });

      const result = await controller.reveal('gs-7', { password: 'my-password' } as any);

      expect(mockService.revealSecret).toHaveBeenCalledWith('gs-7', 'my-password');
      expect(result.id).toBe('gs-7');
      expect(result.key).toBe('secrets.api-token');
      expect(result.value).toBe('plaintext-secret');
      expect(typeof result.revealedAt).toBe('string');
    });

    // The reveal route carries a method-level `@Authorize(['manage','all'])`
    // which OVERRIDES the class-level `@CanManage('GlobalSetting')` — the
    // UnifiedAuthGuard resolves required-permission metadata via
    // getAllAndOverride([handler, class]). Result: GLOBAL_ADMIN-only; a tenant
    // admin (has manage:GlobalSetting, not manage:all) is 403.
    it('is gated GLOBAL_ADMIN-only via @Authorize(["manage","all"]) (overrides the class gate)', () => {
      const methodMeta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, GlobalSettingController.prototype.reveal) as
        | Array<{ action: string; subject: string }>
        | undefined;
      expect(methodMeta).toEqual([{ action: 'manage', subject: 'all' }]);

      // The class default is the broader manage:GlobalSetting (tenant admins included),
      // proving the method-level gate is a deliberate tightening.
      const classMeta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, GlobalSettingController) as
        | Array<{ action: string; subject: string }>
        | undefined;
      expect(classMeta).toEqual([{ action: 'manage', subject: 'GlobalSetting' }]);
    });
  });
});
