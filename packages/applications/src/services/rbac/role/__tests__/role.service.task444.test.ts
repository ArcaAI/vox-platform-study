/**
 * Member counts on the role reads. `findAll`/`findOne` merge a
 * tenant-filtered `_count.UserRoleAssignments` into the canonical
 * `ROLE_POLICIES_INCLUDE` so the admin console's list chips render without one
 * request per row.
 *
 * Tenant-scoping decision (item 1): the nested `_count` is NOT
 * intercepted by the tenant-scope `$extends` (query extensions only touch the
 * TOP-LEVEL args of the dispatched model), so the service builds the filter
 * explicitly from CLS — `tenantId` pinned when the caller carries a tenant
 * context, omitted for the unscoped platform-admin path. Non-DELETED matches
 * what the members listing itself returns (soft-delete extension parity).
 */

import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType, ROLE_POLICIES_INCLUDE } from '@arcaai/domains';
import { RbacRoleService } from '../role.service';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };
const TENANT_ID = 'tenant-001';

function makeMocks({ tenantId }: { tenantId: string | null } = { tenantId: TENANT_ID }) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return ADMIN_USER;
      if (key === 'tenantId') return tenantId;
      if (key === 'correlationId') return 'corr-1';
      if (key === 'requestIp') return '10.0.0.1';
      return null;
    }),
    set: vi.fn(),
  };
  const eventEmitter = { emit: vi.fn() };
  const roleRepo = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findByIdWithPolicies: vi.fn().mockResolvedValue(null),
    findByIdGuardSelect: vi.fn(),
    findParentRoleById: vi.fn(),
    findParentRoleIdById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  };
  const rolePolicyRepo = {
    findFirstByRoleAndPolicy: vi.fn(),
    create: vi.fn(),
    reEnable: vi.fn(),
    softDeleteByRoleAndPolicy: vi.fn(),
  };
  const policyRepo = { findById: vi.fn() };
  const userRepo = { findById: vi.fn() };
  const crypto = { verify: vi.fn() };
  const engine = { invalidateRole: vi.fn() };
  return { cls, eventEmitter, roleRepo, rolePolicyRepo, policyRepo, userRepo, crypto, engine };
}

function buildService(mocks: ReturnType<typeof makeMocks>) {
  return new RbacRoleService(
    mocks.roleRepo as never,
    mocks.rolePolicyRepo as never,
    mocks.policyRepo as never,
    mocks.userRepo as never,
    mocks.crypto as never,
    mocks.engine as never,
    mocks.eventEmitter as never,
    mocks.cls as never,
  );
}

/** Include shape the reads must carry: policies + tenant-filtered member count. */
function expectedInclude(tenantId: string | null) {
  return {
    ...ROLE_POLICIES_INCLUDE,
    _count: {
      select: {
        UserRoleAssignments: {
          where: {
            resourceStatus: { not: ResourceStatusType.DELETED },
            ...(tenantId ? { tenantId } : {}),
          },
        },
      },
    },
  };
}

describe('RbacRoleService member counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findAll merges a tenant-scoped _count.UserRoleAssignments into the include', async () => {
    const mocks = makeMocks();
    const service = buildService(mocks);

    await service.findAll({ page: 1, pageSize: 20 });

    expect(mocks.roleRepo.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: expectedInclude(TENANT_ID) }));
  });

  it('findAll omits the tenantId filter for an unscoped (no CLS tenant) caller', async () => {
    const mocks = makeMocks({ tenantId: null });
    const service = buildService(mocks);

    await service.findAll({ page: 1, pageSize: 20 });

    expect(mocks.roleRepo.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: expectedInclude(null) }));
  });

  it('findOne passes the member-count include to findByIdWithPolicies and surfaces _count', async () => {
    const mocks = makeMocks();
    const row = { id: 'role-1', name: 'doctor', RolePolicies: [], _count: { UserRoleAssignments: 4 } };
    mocks.roleRepo.findByIdWithPolicies.mockResolvedValue(row);
    const service = buildService(mocks);

    const result = await service.findOne('role-1');

    expect(mocks.roleRepo.findByIdWithPolicies).toHaveBeenCalledWith('role-1', expectedInclude(TENANT_ID));
    expect(result).toBe(row);
  });
});
