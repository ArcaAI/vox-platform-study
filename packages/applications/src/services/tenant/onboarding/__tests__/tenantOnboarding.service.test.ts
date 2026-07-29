import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantOnboardingService } from '../tenantOnboarding.service';
import { ResourceStatusType, TenantPlan } from '@arcaai/domains';

// Mirrors HarnessInternalService's ClsService test double
// (Map-backed store; `run` just invokes the callback synchronously).
const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

const mockEventEmitter = { emit: vi.fn() };

const mockTenantService = {
  create: vi.fn(),
  deleteById: vi.fn(),
};

const mockUserService = {
  create: vi.fn(),
  fetchById: vi.fn(),
};

const mockUserRoleAssignmentService = {
  create: vi.fn(),
};

const mockDepartmentRepository = {
  findByCode: vi.fn(),
};

const mockUserDepartmentRepository = {
  create: vi.fn(),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    UserDepartmentFactory: {
      CreateUserDepartment: vi.fn((data) => ({
        ...data,
        id: 'user-department-1',
        toObject: vi.fn().mockReturnValue({ ...data }),
      })),
    },
  };
});

const createMockTenantEntity = (overrides: Partial<{ id: string; key: string; name: string; plan: TenantPlan | null }> = {}) => ({
  id: overrides.id ?? 'new-tenant-id',
  key: overrides.key ?? 'acme-health',
  name: overrides.name ?? 'Acme Health',
  plan: overrides.plan ?? TenantPlan.STARTER,
});

const createMockUserEntity = (overrides: Partial<{ id: string; resourceStatus: ResourceStatusType }> = {}) => ({
  id: overrides.id ?? 'existing-admin-id',
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
});

describe('TenantOnboardingService (§3.3)', () => {
  let service: TenantOnboardingService;
  let cls: ReturnType<typeof createMockClsService>;

  const actor = { userId: 'actor-id', tenantId: 'actor-tenant-id' };

  beforeEach(() => {
    vi.clearAllMocks();
    cls = createMockClsService();

    mockTenantService.create.mockResolvedValue(createMockTenantEntity());
    mockDepartmentRepository.findByCode.mockResolvedValue({ id: 'gen-dept-id', code: 'GEN' });
    mockUserRoleAssignmentService.create.mockResolvedValue({ id: 'role-assignment-1' });
    mockUserDepartmentRepository.create.mockImplementation(async (entity: any) => entity);

    service = new TenantOnboardingService(
      mockTenantService as any,
      mockUserService as any,
      mockUserRoleAssignmentService as any,
      mockDepartmentRepository as any,
      mockUserDepartmentRepository as any,
      mockEventEmitter as any,
      cls as any,
    );
  });

  describe('existing-admin path', () => {
    it('validates the admin is active BEFORE creating the tenant', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity({ resourceStatus: ResourceStatusType.DISABLED }));

      await expect(
        service.provisionTenantWithAdmin({
          tenantName: 'Acme Health',
          admin: { kind: 'existing', userId: 'existing-admin-id' },
          actor,
        }),
      ).rejects.toThrow();

      expect(mockTenantService.create).not.toHaveBeenCalled();
    });

    it('creates the tenant, assigns TENANT_ADMIN, and attaches the GEN department', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());

      const result = await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        admin: { kind: 'existing', userId: 'existing-admin-id' },
        actor,
      });

      expect(mockTenantService.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme Health' }));
      expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'existing-admin-id', roleId: '00000000-0000-0000-0000-000000000002' }),
      );
      expect(mockDepartmentRepository.findByCode).toHaveBeenCalledWith('new-tenant-id', 'GEN');
      expect(mockUserDepartmentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'new-tenant-id', userId: 'existing-admin-id', departmentId: 'gen-dept-id', isPrimary: true }),
      );
      expect(result).toEqual({
        tenant: expect.objectContaining({ id: 'new-tenant-id' }),
        adminUserId: 'existing-admin-id',
        tenantKey: 'acme-health',
      });
    });

    it('switches CLS to the new tenant before writing membership rows', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());

      await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        admin: { kind: 'existing', userId: 'existing-admin-id' },
        actor,
      });

      expect(cls.set).toHaveBeenCalledWith('tenantId', 'new-tenant-id');
    });
  });

  describe('new-local-admin path', () => {
    it('creates the local user atomically with role + department via UserService.create', async () => {
      mockUserService.create.mockResolvedValue({ id: 'new-local-admin-id' });

      const result = await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        admin: { kind: 'new-local', email: 'admin@acme.test', password: 'S3cret!Pass' },
        actor,
      });

      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'admin@acme.test',
          password: 'S3cret!Pass',
          roleId: '00000000-0000-0000-0000-000000000002',
          departmentId: 'gen-dept-id',
          isPrimaryDepartment: true,
        }),
      );
      // No separate role-assignment/department-attach calls — UserService.create
      // already did both atomically.
      expect(mockUserRoleAssignmentService.create).not.toHaveBeenCalled();
      expect(mockUserDepartmentRepository.create).not.toHaveBeenCalled();
      expect(result.adminUserId).toBe('new-local-admin-id');
    });

    it('defaults username to email when username is omitted', async () => {
      mockUserService.create.mockResolvedValue({ id: 'new-local-admin-id' });

      await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        admin: { kind: 'new-local', email: 'admin@acme.test', password: 'S3cret!Pass' },
        actor,
      });

      expect(mockUserService.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'admin@acme.test' }));
    });
  });

  describe('guardrail — never adminless (§1c.3)', () => {
    it('rolls back (soft-deletes) the tenant when TENANT_ADMIN assignment fails', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());
      mockUserRoleAssignmentService.create.mockRejectedValue(new Error('seat quota exceeded'));

      await expect(
        service.provisionTenantWithAdmin({
          tenantName: 'Acme Health',
          admin: { kind: 'existing', userId: 'existing-admin-id' },
          actor,
        }),
      ).rejects.toThrow('seat quota exceeded');

      expect(mockTenantService.deleteById).toHaveBeenCalledWith('new-tenant-id');
    });

    it('rolls back when the GEN department was not provisioned', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());
      mockDepartmentRepository.findByCode.mockResolvedValue(null);

      await expect(
        service.provisionTenantWithAdmin({
          tenantName: 'Acme Health',
          admin: { kind: 'existing', userId: 'existing-admin-id' },
          actor,
        }),
      ).rejects.toThrow();

      expect(mockTenantService.deleteById).toHaveBeenCalledWith('new-tenant-id');
    });

    it('does not swallow the original error when the rollback itself fails', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());
      mockUserRoleAssignmentService.create.mockRejectedValue(new Error('seat quota exceeded'));
      mockTenantService.deleteById.mockRejectedValue(new Error('db down'));

      await expect(
        service.provisionTenantWithAdmin({
          tenantName: 'Acme Health',
          admin: { kind: 'existing', userId: 'existing-admin-id' },
          actor,
        }),
      ).rejects.toThrow('seat quota exceeded');
    });
  });

  describe('plan + key pass-through', () => {
    it('defaults the plan to STARTER when omitted', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());

      await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        admin: { kind: 'existing', userId: 'existing-admin-id' },
        actor,
      });

      expect(mockTenantService.create).toHaveBeenCalledWith(expect.objectContaining({ plan: TenantPlan.STARTER }));
    });

    it('passes an explicit tenantKey through to TenantService.create', async () => {
      mockUserService.fetchById.mockResolvedValue(createMockUserEntity());

      await service.provisionTenantWithAdmin({
        tenantName: 'Acme Health',
        tenantKey: 'acme-explicit',
        admin: { kind: 'existing', userId: 'existing-admin-id' },
        actor,
      });

      expect(mockTenantService.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'acme-explicit' }));
    });
  });
});
