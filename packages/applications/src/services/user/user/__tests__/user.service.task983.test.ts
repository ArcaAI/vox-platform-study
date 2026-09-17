/**
 * TASK-983 R6 / OD-4 — a tenant-scoped create must carry its membership.
 *
 * Reported defect: a tenant admin could create a user with neither a role nor
 * a department. `User` carries no `tenantId` (membership IS the
 * `UserRoleAssignment` + `UserDepartment` pair), so such a row belongs to no
 * tenant: it is excluded from `fetchAllByTenantId`, every `admin/users/:id/*`
 * sub-route 404s through `assertUserInScope`, and it can never log in — an
 * orphan its own creator cannot reopen to fix.
 *
 * Contract pinned here (mirrors `ContextUserIdentityService`, TASK-950, which
 * has treated role AND department as mandatory and fail-closed since it
 * shipped):
 *   - caller acting INSIDE a tenant (CLS `tenantId` set): `roleId` is
 *     mandatory (400 `USER_ROLE_REQUIRED`) and, for a human account,
 *     `departmentId` is too (400 `USER_DEPARTMENT_REQUIRED`). Raised BEFORE
 *     any write, any password hashing and any seat count.
 *   - service accounts keep the department exemption (`assertUserBelongsToTenant`
 *     exempts them from the department half, not from the role half).
 *   - caller with NO tenant context (a super admin creating a tenant-less
 *     platform user) keeps today's membership-less path unchanged.
 *   - a non-super-admin caller may not name the platform-wide `SUPER_ADMIN`
 *     role — the same guard `UserRoleAssignmentService.create` applies, which
 *     this path bypassed by writing the assignment through the repository.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SysEventType, ResourceType } from '@arcaai/domains';
import { UserService } from '../user.service';

const TENANT = 'tenant-T';
const TX = { __txSentinel: true };

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { create: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };

const $transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
// `Role` is a SYSTEM shared-read model; the tier guard reads it through the
// unscoped base client, exactly as `UserRoleAssignmentService` does.
const roleFindUnique = vi.fn(async () => ({ name: 'DOCTOR' }));
const mockDatabaseService = { baseClient: { $transaction, role: { findUnique: roleFindUnique } } };
const mockUserProfileService = { upsertByUserId: vi.fn() };
const mockCryptoService = { hash: vi.fn(async (pw: string) => `$2b$10$hashed::${pw}`), verify: vi.fn() };
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

/** CLS shape: `tenantId` null models a super admin with no working tenant. */
function withContext(tenantId: string | null, roles: string[] = ['TENANT_ADMIN']) {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'admin-1', firstName: 'A', lastName: 'D', email: 'a@d.com', roles };
      case 'tenantId':
        return tenantId;
      default:
        return null;
    }
  });
}

function expectNothingWritten() {
  expect($transaction).not.toHaveBeenCalled();
  expect(mockUserRepository.create).not.toHaveBeenCalled();
  expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
  expect(mockUserDepartmentRepository.create).not.toHaveBeenCalled();
  expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
}

describe('UserService.create — mandatory tenant membership (TASK-983 R6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleFindUnique.mockResolvedValue({ name: 'DOCTOR' } as never);
    withContext(TENANT);
    mockUserRepository.create.mockImplementation(async (entity: any) => entity);
    mockUserRoleAssignmentRepository.create.mockImplementation(async (entity: any) => entity);
    mockUserDepartmentRepository.create.mockImplementation(async (entity: any) => entity);
  });

  it('refuses a tenant-scoped create with no role (400 USER_ROLE_REQUIRED) before any write', async () => {
    const service = buildService();

    await expect(service.create({ username: 'orphan', password: 'Password123!' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ username: 'orphan', password: 'Password123!' } as any)).rejects.toMatchObject({
      response: { code: 'USER_ROLE_REQUIRED' },
    });

    // Fail-closed: the password is not even hashed on the refused path.
    expect(mockCryptoService.hash).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses a tenant-scoped HUMAN create with a role but no department (400 USER_DEPARTMENT_REQUIRED)', async () => {
    const service = buildService();

    await expect(service.create({ username: 'roleonly', password: 'Password123!', roleId: 'role-1' } as any)).rejects.toMatchObject({
      response: { code: 'USER_DEPARTMENT_REQUIRED' },
    });

    expectNothingWritten();
  });

  it('accepts a SERVICE ACCOUNT with a role and no department (the department exemption)', async () => {
    const service = buildService();

    await service.create({ username: 'svc-bot', password: 'Password123!', isServiceAccount: true, roleId: 'role-1' } as any);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockUserDepartmentRepository.create).not.toHaveBeenCalled();
  });

  it('still refuses a SERVICE ACCOUNT with no role — the role half is not exempt', async () => {
    const service = buildService();

    await expect(service.create({ username: 'svc-bot', password: 'Password123!', isServiceAccount: true } as any)).rejects.toMatchObject({
      response: { code: 'USER_ROLE_REQUIRED' },
    });

    expectNothingWritten();
  });

  it('leaves the tenant-LESS platform-user path unchanged (no role, no department, no transaction)', async () => {
    withContext(null, ['SUPER_ADMIN']);
    const service = buildService();

    const user = await service.create({ username: 'platform-admin', password: 'Password123!' } as any);

    expect(user.username).toBe('platform-admin');
    expect($transaction).not.toHaveBeenCalled();
    expect(mockUserRepository.create).toHaveBeenCalledTimes(1);
    expect(mockUserRepository.create.mock.calls[0][1]).toBeUndefined();
  });

  it('creates user + role + department in ONE transaction and broadcasts three sys-events', async () => {
    const service = buildService();

    await service.create({
      username: 'mia.okafor',
      password: 'Password123!',
      roleId: 'role-1',
      departmentId: 'dept-1',
      isPrimaryDepartment: true,
    } as any);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(mockUserRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockUserDepartmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

    // Entities come from the real domain factories (uuidv7 ids, change tracking).
    const userArg = mockUserRepository.create.mock.calls[0][0] as any;
    const roleArg = mockUserRoleAssignmentRepository.create.mock.calls[0][0] as any;
    const deptArg = mockUserDepartmentRepository.create.mock.calls[0][0] as any;
    expect(roleArg.toObject()).toMatchObject({ roleId: 'role-1', tenantId: TENANT, userId: userArg.id });
    expect(deptArg.toObject()).toMatchObject({ departmentId: 'dept-1', tenantId: TENANT, userId: userArg.id, isPrimary: true });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: userArg.id }));
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceType: ResourceType.UserRoleAssignment, tenantId: TENANT }),
    );
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceType: ResourceType.UserDepartment, tenantId: TENANT }),
    );
  });

  it('refuses a non-super-admin caller naming the SUPER_ADMIN role (403), before any write', async () => {
    roleFindUnique.mockResolvedValue({ name: 'SUPER_ADMIN' } as never);
    const service = buildService();

    await expect(
      service.create({ username: 'escalate', password: 'Password123!', roleId: 'role-super', departmentId: 'dept-1' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expectNothingWritten();
  });

  it('lets a SUPER_ADMIN caller assign the SUPER_ADMIN role', async () => {
    roleFindUnique.mockResolvedValue({ name: 'SUPER_ADMIN' } as never);
    withContext(TENANT, ['SUPER_ADMIN']);
    const service = buildService();

    await service.create({ username: 'second-admin', password: 'Password123!', roleId: 'role-super', departmentId: 'dept-1' } as any);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
  });
});
