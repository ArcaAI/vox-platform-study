/**
 * TASK-331 r2605 #3 — Console-created users must satisfy the Phase F login
 * invariant (an ENABLED UserRoleAssignment AND an ENABLED UserDepartment in a
 * tenant). `UserService.create` now optionally creates the role/department
 * membership ATOMICALLY with the user, scoped to the ACTIVE CLS tenant. A
 * partial failure rolls everything back so no orphan user row survives.
 *
 * These tests use the REAL domain factories (the service builds entities via
 * them) and mock the repositories + the `$transaction` boundary. Each membership
 * write goes through `repository.create(entity, tx)`, so the tx sentinel must be
 * threaded to all three repositories; success events are broadcast only AFTER
 * the transaction commits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SysEventType, ResourceType } from '@arcaai/domains';
import { UserService } from '../user.service';

const TENANT = 'tenant-T';
const TX = { __txSentinel: true };

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { create: vi.fn() };
const mockUserRoleAssignmentRepository = { create: vi.fn() };
const mockUserDepartmentRepository = { create: vi.fn() };

// $transaction faithfully runs the work callback with a tx sentinel and returns
// its resolved value; if the callback throws, the promise rejects (Postgres
// rollback semantics — no committed rows, no post-commit side effects).
const $transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
const mockDatabaseService = { baseClient: { $transaction } };

function buildService() {
  return new UserService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserRoleAssignmentRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserDepartmentRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockEventEmitter as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockClsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDatabaseService as any,
  );
}

describe('UserService — TASK-331 #3 create-with-membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'admin-1', firstName: 'A', lastName: 'D', email: 'a@d.com', roles: ['TENANT_ADMIN'] };
        case 'tenantId':
          return TENANT;
        default:
          return null;
      }
    });
    // Repositories echo the entity they were handed (the real factory-built
    // entity carries id/createdAt/toObject()).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserRepository.create.mockImplementation(async (entity: any) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserRoleAssignmentRepository.create.mockImplementation(async (entity: any) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUserDepartmentRepository.create.mockImplementation(async (entity: any) => entity);
  });

  it('persists user + role + department atomically scoped to the CLS tenant', async () => {
    const service = buildService();

    const result = await service.create({
      username: 'newuser',
      password: 'pw',
      isServiceAccount: false,
      roleId: 'role-1',
      departmentId: 'dept-1',
      isPrimaryDepartment: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect($transaction).toHaveBeenCalledTimes(1);

    // All three writes participate in the SAME transaction (tx sentinel).
    expect(mockUserRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockUserDepartmentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userArg = mockUserRepository.create.mock.calls[0][0] as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleArg = mockUserRoleAssignmentRepository.create.mock.calls[0][0] as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deptArg = mockUserDepartmentRepository.create.mock.calls[0][0] as any;

    expect(roleArg.toObject()).toMatchObject({ roleId: 'role-1', tenantId: TENANT, userId: userArg.id });
    expect(deptArg.toObject()).toMatchObject({ departmentId: 'dept-1', tenantId: TENANT, userId: userArg.id, isPrimary: true });

    expect(result.username).toBe('newuser');

    // Membership events carry the membership resourceType and the CLS tenant.
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceType: ResourceType.UserRoleAssignment, tenantId: TENANT }),
    );
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceType: ResourceType.UserDepartment, tenantId: TENANT }),
    );
  });

  it('rolls back (no committed writes, no audit events) when the department write fails', async () => {
    mockUserDepartmentRepository.create.mockRejectedValueOnce(new Error('department write failed'));
    const service = buildService();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.create({ username: 'newuser', password: 'pw', roleId: 'role-1', departmentId: 'dept-1' } as any),
    ).rejects.toThrow(/department write failed/);

    // Broadcasting happens AFTER the transaction commits, so a failed tx emits
    // NO ResourceCreated events for the user/role (no orphan side effects).
    expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('creates only a role membership when departmentId is omitted', async () => {
    const service = buildService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await service.create({ username: 'roleonly', password: 'pw', roleId: 'role-1' } as any);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalledTimes(1);
    expect(mockUserDepartmentRepository.create).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when membership is requested but the CLS tenant is empty', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['TENANT_ADMIN'] } : null));
    const service = buildService();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.create({ username: 'newuser', password: 'pw', roleId: 'role-1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect($transaction).not.toHaveBeenCalled();
    expect(mockUserRepository.create).not.toHaveBeenCalled();
  });

  it('leaves the no-membership create path unchanged (repository.create without a transaction)', async () => {
    const service = buildService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await service.create({ username: 'plain', password: 'pw' } as any);

    expect(mockUserRepository.create).toHaveBeenCalledTimes(1);
    // No tx argument on the plain path.
    expect(mockUserRepository.create.mock.calls[0][1]).toBeUndefined();
    expect($transaction).not.toHaveBeenCalled();
    expect(result.username).toBe('plain');
  });
});
