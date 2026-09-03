/**
 * `Role` is tenant-scoped, so a tenant admin can manage its
 * OWN tenant's custom roles without being able to touch anybody else's.
 *
 * This file covers the three boundaries the owner decision names, and nothing
 * else (the pre-existing CRUD/break-glass behaviour stays in
 * `role.service.task307.test.ts` / `role.service.break-glass.task409.test.ts`):
 *
 *   1. A tenant admin may READ / UPDATE / DELETE a role its OWN tenant owns.
 *   2. A CROSS-TENANT id yields 404, never 403 — and the write is never
 *      attempted. This is the 404-over-403 posture, and it is produced by the
 *      DATA layer: `Role` is a SYSTEM-shared read model, so the tenant-scope
 *      extension widens reads to `[caller, SYSTEM]` only, and a foreign id
 *      simply resolves to `null`. The specs below model that by having the
 *      guard-select mock return `null` for a foreign id, which is exactly what
 *      the extended client does at runtime.
 *   3. A SYSTEM-owned role stays SUPER-ADMIN-only. Note this covers MORE than
 *      the five `isSystemRole: true` built-ins: `DEPARTMENT_HEAD` and
 *      `SENIOR_NURSE` are seeded `isSystemRole: false` yet live on the SYSTEM
 *      tenant as clonable platform templates, and before OD-1 they were the
 *      concrete way a tenant admin could edit platform-wide data. A SYSTEM row
 *      is a 403 (privilege), NOT a 404 — the tenant can legitimately SEE it.
 */

import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { RbacRoleService } from '../role.service';

const SUPER_ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com', roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN_USER = { id: 'tadmin-001', firstName: 'Ten', lastName: 'Admin', email: 'tadmin@arcaai.com', roles: ['TENANT_ADMIN'] };

/** The caller's own tenant. */
const TENANT_ID = 'tenant-001';
/** Somebody else's tenant — never reachable, and never named in a response. */
const OTHER_TENANT_ID = 'tenant-002';

const BREAK_GLASS = (name: string) => ({ password: 'pw', confirmationName: name });

/** A role owned by the caller's own tenant — the thing OD-1 unblocks. */
const OWN_ROLE = { id: 'role-own', name: 'CARE_COORDINATOR', isSystemRole: false, tenantId: TENANT_ID };
/** A platform built-in: SYSTEM-owned AND flagged. */
const SYSTEM_FLAGGED_ROLE = { id: 'role-doctor', name: 'DOCTOR', isSystemRole: true, tenantId: SYSTEM_TENANT_ID };
/**
 * A platform TEMPLATE: SYSTEM-owned but `isSystemRole: false` (the seeded
 * DEPARTMENT_HEAD / SENIOR_NURSE shape). The `isSystemRole` guard alone does
 * NOT stop a tenant admin here — the tenant-ownership check is what does.
 */
const SYSTEM_TEMPLATE_ROLE = { id: 'role-dept-head', name: 'DEPARTMENT_HEAD', isSystemRole: false, tenantId: SYSTEM_TENANT_ID };

function makeMocks(user: typeof SUPER_ADMIN_USER = TENANT_ADMIN_USER, tenantId: string | null = TENANT_ID) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return tenantId;
      if (key === 'correlationId') return 'corr-1';
      if (key === 'requestIp') return '10.0.0.1';
      return null;
    }),
    set: vi.fn(),
  };

  const roleRepo = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findByIdWithPolicies: vi.fn(),
    findByIdGuardSelect: vi.fn(),
    findParentRoleById: vi.fn(),
    findParentRoleIdById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(undefined),
  };

  return {
    cls,
    eventEmitter: { emit: vi.fn() },
    roleRepo,
    rolePolicyRepo: {
      findFirstByRoleAndPolicy: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      reEnable: vi.fn().mockResolvedValue(undefined),
      softDeleteByRoleAndPolicy: vi.fn().mockResolvedValue(undefined),
    },
    policyRepo: { findById: vi.fn().mockResolvedValue({ id: 'policy-1', name: 'team-policy', isProtected: false }) },
    userRepo: { findById: vi.fn().mockResolvedValue({ id: user.id, password: 'stored-hash' }) },
    crypto: { verify: vi.fn().mockResolvedValue(true) },
    engine: { invalidateRole: vi.fn().mockResolvedValue(undefined) },
  };
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

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-own',
    tenantId: TENANT_ID,
    name: 'CARE_COORDINATOR',
    description: null,
    externalName: null,
    externalId: null,
    isSystemRole: false,
    parentRoleId: null,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    RolePolicies: [],
    ...overrides,
  };
}

describe(' OD-1 — Role tenancy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. A tenant admin may manage its OWN tenant's roles ────────────────────
  describe('a tenant admin and its own tenant’s custom role', () => {
    it('READS it, and the record carries the owning tenant', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdWithPolicies.mockResolvedValue(roleRow());
      const service = buildService(mocks);

      const role = await service.findOne('role-own');

      expect(role?.tenantId).toBe(TENANT_ID);
    });

    it('UPDATES it — no lane needed, because the row is already in the caller’s tenant', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(OWN_ROLE);
      mocks.roleRepo.update.mockResolvedValue(roleRow({ name: 'CARE_LEAD' }));
      const service = buildService(mocks);

      await service.update('role-own', { name: 'CARE_LEAD' });

      expect(mocks.roleRepo.update).toHaveBeenCalledWith('role-own', expect.objectContaining({ name: 'CARE_LEAD' }), false);
    });

    it('PATCHES it', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(OWN_ROLE);
      mocks.roleRepo.update.mockResolvedValue(roleRow());
      const service = buildService(mocks);

      await service.patch('role-own', { description: 'now with more coordinating' });

      expect(mocks.roleRepo.update).toHaveBeenCalledTimes(1);
    });

    it('DELETES it (with the break-glass step-up the route already demands)', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(OWN_ROLE);
      const service = buildService(mocks);

      await service.softDelete('role-own', BREAK_GLASS('CARE_COORDINATOR'));

      expect(mocks.roleRepo.softDelete).toHaveBeenCalledWith('role-own', TENANT_ADMIN_USER.id, false);
    });

    it('CREATES one stamped with its own tenant, never SYSTEM', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.create.mockResolvedValue(roleRow({ id: 'role-new' }));
      const service = buildService(mocks);

      await service.create({ name: 'CARE_COORDINATOR' });

      expect(mocks.roleRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));
    });

    it('CLONES a SYSTEM built-in into its OWN tenant — the supported way to get an editable copy', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdWithPolicies.mockResolvedValue(roleRow({ id: 'role-doctor', tenantId: SYSTEM_TENANT_ID, name: 'DOCTOR' }));
      mocks.roleRepo.create.mockResolvedValue(roleRow({ id: 'role-clone', name: 'DOCTOR (copy)' }));
      const service = buildService(mocks);

      await service.clone('role-doctor', { name: 'DOCTOR (copy)' });

      expect(mocks.roleRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID, name: 'DOCTOR (copy)' }));
    });
  });

  // ── 2. Cross-tenant id → 404, never 403 ────────────────────────────────────
  describe('a cross-tenant role id (404-over-403)', () => {
    // The tenant-scope extension widens Role READS to [caller, SYSTEM] only, so
    // another tenant's row is invisible: the guard-select resolves to null.
    const invisible = () => null;

    it('findOne returns null rather than another tenant’s row', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdWithPolicies.mockResolvedValue(invisible());
      const service = buildService(mocks);

      await expect(service.findOne('role-of-tenant-002')).resolves.toBeNull();
    });

    it('update → 404 (NOT 403), and no write is attempted', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(invisible());
      const service = buildService(mocks);

      await expect(service.update('role-of-tenant-002', { name: 'hijack' })).rejects.toMatchObject({
        status: 404,
        message: 'Role not found',
      });
      expect(mocks.roleRepo.update).not.toHaveBeenCalled();
    });

    it('softDelete → 404 (NOT 403), and no write is attempted', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(invisible());
      const service = buildService(mocks);

      await expect(service.softDelete('role-of-tenant-002', BREAK_GLASS('whatever'))).rejects.toMatchObject({ status: 404 });
      expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    });

    it('the 404 leaks nothing about the other tenant', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(invisible());
      const service = buildService(mocks);

      const error = await service.update('role-of-tenant-002', { name: 'hijack' }).catch((e: Error) => e);

      expect(error.message).not.toContain(OTHER_TENANT_ID);
      expect(error.message).toBe('Role not found');
    });
  });

  // ── 3. SYSTEM roles stay super-admin-only ──────────────────────────────────
  describe('a SYSTEM-owned role and a tenant admin', () => {
    it('is READABLE — it is in the tenant’s list and they assign users to it', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdWithPolicies.mockResolvedValue(roleRow({ id: 'role-doctor', tenantId: SYSTEM_TENANT_ID, name: 'DOCTOR' }));
      const service = buildService(mocks);

      const role = await service.findOne('role-doctor');

      expect(role?.tenantId).toBe(SYSTEM_TENANT_ID);
    });

    it('refuses UPDATE of a flagged built-in and never writes', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_FLAGGED_ROLE);
      const service = buildService(mocks);

      await expect(service.update('role-doctor', { name: 'DOCTOR-hijacked' })).rejects.toThrow(/System roles are protected/);
      expect(mocks.roleRepo.update).not.toHaveBeenCalled();
    });

    it('refuses DELETE of a flagged built-in and never writes', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_FLAGGED_ROLE);
      const service = buildService(mocks);

      await expect(service.softDelete('role-doctor', BREAK_GLASS('DOCTOR'))).rejects.toThrow(/Cannot delete system role/);
      expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    });

    /**
     * The case the `isSystemRole` flag alone does NOT catch, and the concrete
     * hole OD-1 closes: DEPARTMENT_HEAD / SENIOR_NURSE are seeded
     * `isSystemRole: false` but owned by SYSTEM. Only the tenant-ownership
     * check refuses these.
     */
    it('refuses UPDATE of an UNFLAGGED SYSTEM template with 403 — the hole isSystemRole missed', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_TEMPLATE_ROLE);
      const service = buildService(mocks);

      await expect(service.update('role-dept-head', { name: 'DEPARTMENT_HEAD-hijacked' })).rejects.toMatchObject({ status: 403 });
      expect(mocks.roleRepo.update).not.toHaveBeenCalled();
    });

    it('refuses DELETE of an UNFLAGGED SYSTEM template with 403', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_TEMPLATE_ROLE);
      const service = buildService(mocks);

      await expect(service.softDelete('role-dept-head', BREAK_GLASS('DEPARTMENT_HEAD'))).rejects.toMatchObject({ status: 403 });
      expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    });

    /**
     * `RolePolicy` is a GLOBAL join table, so attaching to a SYSTEM role would
     * change the grant for EVERY tenant — the same boundary, a different door.
     */
    it('refuses attaching a policy to an UNFLAGGED SYSTEM template', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_TEMPLATE_ROLE);
      const service = buildService(mocks);

      await expect(service.assignPolicy('role-dept-head', 'policy-1', {})).rejects.toMatchObject({ status: 403 });
      expect(mocks.rolePolicyRepo.create).not.toHaveBeenCalled();
      expect(mocks.rolePolicyRepo.reEnable).not.toHaveBeenCalled();
    });

    it('refuses detaching a policy from an UNFLAGGED SYSTEM template', async () => {
      const mocks = makeMocks();
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_TEMPLATE_ROLE);
      const service = buildService(mocks);

      await expect(service.removePolicy('role-dept-head', 'policy-1', BREAK_GLASS('team-policy'))).rejects.toMatchObject({ status: 403 });
      expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
    });
  });

  // ── The super-admin side of the same boundary ──────────────────────────────
  describe('a super admin', () => {
    it('edits a SYSTEM role through the UNSCOPED lane when a working tenant is selected', async () => {
      // The failure this prevents: CLS carries working tenant W, so the extended
      // client would pin the write to W, match zero rows and raise P2025.
      const mocks = makeMocks(SUPER_ADMIN_USER, TENANT_ID);
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_FLAGGED_ROLE);
      mocks.roleRepo.update.mockResolvedValue(roleRow({ id: 'role-doctor', tenantId: SYSTEM_TENANT_ID }));
      const service = buildService(mocks);

      await service.update('role-doctor', { description: 'platform edit' });

      expect(mocks.roleRepo.update).toHaveBeenCalledWith('role-doctor', expect.anything(), true);
    });

    it('edits a SYSTEM role WITHOUT the lane when no working tenant is selected', async () => {
      // No CLS tenant: the extension passes a super admin straight through, so
      // the scoped client is already correct and the lane must stay off.
      const mocks = makeMocks(SUPER_ADMIN_USER, null);
      mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_FLAGGED_ROLE);
      mocks.roleRepo.update.mockResolvedValue(roleRow({ id: 'role-doctor', tenantId: SYSTEM_TENANT_ID }));
      const service = buildService(mocks);

      await service.update('role-doctor', { description: 'platform edit' });

      expect(mocks.roleRepo.update).toHaveBeenCalledWith('role-doctor', expect.anything(), false);
    });

    it('creates a SYSTEM-owned role when acting with no working tenant', async () => {
      const mocks = makeMocks(SUPER_ADMIN_USER, null);
      mocks.roleRepo.create.mockResolvedValue(roleRow({ tenantId: SYSTEM_TENANT_ID }));
      const service = buildService(mocks);

      await service.create({ name: 'PLATFORM_AUDITOR', isSystemRole: true });

      expect(mocks.roleRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, isSystemRole: true }));
    });
  });
});
