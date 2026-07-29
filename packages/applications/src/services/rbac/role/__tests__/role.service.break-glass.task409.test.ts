/**
 * RbacRoleService break-glass second confirmation.
 *
 * Matrix pinned here:
 *   1. Role DELETE requires step-up (password + exact role name):
 *      missing → 428, wrong password → 401, wrong name → 400, correct →
 *      soft-deleted + confirmed audit. The system-role 400 guard fires
 *      BEFORE break-glass (a system role can never be deleted, so no
 *      step-up prompt should leak for it).
 *   2. Detach-from-role (removePolicy) requires step-up against the POLICY
 *      name. Detaching a PROTECTED policy (isProtected OR legacy name) is
 *      absolutely blocked — 403 even with correct credentials — because the
 *      seeded attachment is exactly what keeps super-admins in.
 *   3. Every rejected attempt and every confirmed mutation emits a forced
 *      audit event that never carries the password.
 */
import { vi, describe, beforeEach, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SysEventType } from '@arcaai/domains';
import { RbacRoleService } from '../role.service';
import { RBAC_BREAK_GLASS_AUDIT_ACTION } from '../../breakGlass';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };
const STORED_HASH = 'bcrypt$stored-hash';
const GOOD_PASSWORD = 'correct-horse-battery';

const PLAIN_ROLE = { id: 'role-1', name: 'Care Team', isSystemRole: false };
const SYSTEM_ROLE = { id: 'role-sys', name: 'Super Administrators', isSystemRole: true };

const PLAIN_POLICY = { id: 'policy-1', name: 'team-policy', isProtected: false, rules: [] };
const PROTECTED_POLICY = { id: 'sfa', name: 'system-full-access', isProtected: true, rules: [{ action: 'manage', subject: 'all' }] };
const RENAMED_PROTECTED_POLICY = { id: 'sfa-r', name: 'platform-root-grant', isProtected: true, rules: [{ action: 'manage', subject: 'all' }] };

function makeMocks() {
  const cls = { get: vi.fn((k: string) => (k === 'user' ? ADMIN_USER : k === 'tenantId' ? 'tenant-1' : null)), set: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const roleRepo = {
    findMany: vi.fn(),
    count: vi.fn(),
    findByIdWithPolicies: vi.fn(),
    findByIdGuardSelect: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(undefined),
    findParentRoleById: vi.fn(),
    findParentRoleIdById: vi.fn(),
  };
  const rolePolicyRepo = {
    findFirstByRoleAndPolicy: vi.fn(),
    create: vi.fn(),
    reEnable: vi.fn(),
    softDeleteByRoleAndPolicy: vi.fn().mockResolvedValue({ count: 1 }),
    countEnabledByPolicy: vi.fn().mockResolvedValue(0),
  };
  const policyRepo = { findById: vi.fn().mockResolvedValue(PLAIN_POLICY) };
  const userRepo = { findById: vi.fn().mockResolvedValue({ id: ADMIN_USER.id, password: STORED_HASH }) };
  const crypto = { verify: vi.fn(async (pw: string) => pw === GOOD_PASSWORD) };
  const engine = { invalidateRole: vi.fn().mockResolvedValue(undefined) };
  return { cls, eventEmitter, roleRepo, rolePolicyRepo, policyRepo, userRepo, crypto, engine };
}

function buildService(m: ReturnType<typeof makeMocks>) {
  return new RbacRoleService(
    m.roleRepo as never,
    m.rolePolicyRepo as never,
    m.policyRepo as never,
    m.userRepo as never,
    m.crypto as never,
    m.engine as never,
    m.eventEmitter as never,
    m.cls as never,
  );
}

const GOOD_CREDS = (name: string) => ({ password: GOOD_PASSWORD, confirmationName: name });

function breakGlassAudits(m: ReturnType<typeof makeMocks>) {
  return m.eventEmitter.emit.mock.calls
    .filter(
      ([type, payload]) =>
        type === SysEventType.ResourceViewed && (payload as { data?: { action?: string } })?.data?.action === RBAC_BREAK_GLASS_AUDIT_ACTION,
    )
    .map(([, payload]) => payload as Record<string, never> & { data: Record<string, unknown>; forceAuditLog?: boolean; tenantId?: string });
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof HttpException && err.getStatus() === status);
}

describe('RbacRoleService break-glass on role DELETE', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: RbacRoleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
    mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(PLAIN_ROLE);
  });

  it('missing credentials → 428, delete not performed, rejection audited', async () => {
    await expectStatus(service.softDelete('role-1'), 428);
    expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-missing-credentials');
  });

  it('wrong password → 401, rejection audited', async () => {
    await expect(service.softDelete('role-1', { password: 'nope', confirmationName: 'Care Team' })).rejects.toThrow(UnauthorizedException);
    expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-wrong-password');
  });

  it('wrong confirmationName → 400, rejection audited', async () => {
    await expect(service.softDelete('role-1', { password: GOOD_PASSWORD, confirmationName: 'Wrong Role' })).rejects.toThrow(BadRequestException);
    expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-wrong-name');
  });

  it('correct step-up → role soft-deleted + confirmed audit (no password in payload)', async () => {
    const result = await service.softDelete('role-1', GOOD_CREDS('Care Team'));
    expect(result).toEqual({ id: 'role-1', name: 'Care Team' });
    expect(mocks.roleRepo.softDelete).toHaveBeenCalledWith('role-1', ADMIN_USER.id);
    const audits = breakGlassAudits(mocks);
    expect(audits[0]?.data.outcome).toBe('confirmed');
    expect(audits[0]?.data.operation).toBe('role-delete');
    expect(JSON.stringify(audits)).not.toContain(GOOD_PASSWORD);
  });

  it('system role → 400 BEFORE any break-glass prompt', async () => {
    mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_ROLE);
    await expect(service.softDelete('role-sys', GOOD_CREDS('Super Administrators'))).rejects.toThrow(BadRequestException);
    expect(mocks.crypto.verify).not.toHaveBeenCalled();
    expect(mocks.roleRepo.softDelete).not.toHaveBeenCalled();
  });

  it('missing role → 404 before break-glass', async () => {
    mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(null);
    await expect(service.softDelete('nope')).rejects.toThrow(NotFoundException);
  });
});

describe('RbacRoleService break-glass on detach (removePolicy)', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: RbacRoleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
    // RemovePolicy now pre-checks the role's isSystemRole flag.
    mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(PLAIN_ROLE);
  });

  it('detaching a PROTECTED policy is absolutely blocked (403) even with correct step-up', async () => {
    mocks.policyRepo.findById.mockResolvedValue(PROTECTED_POLICY);
    await expect(service.removePolicy('role-1', 'sfa', GOOD_CREDS('system-full-access'))).rejects.toThrow(ForbiddenException);
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-protected');
  });

  it('detaching a RENAMED protected policy is also blocked (marker-based)', async () => {
    mocks.policyRepo.findById.mockResolvedValue(RENAMED_PROTECTED_POLICY);
    await expect(service.removePolicy('role-1', 'sfa-r', GOOD_CREDS('platform-root-grant'))).rejects.toThrow(ForbiddenException);
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
  });

  it('missing credentials → 428, detach not performed', async () => {
    await expectStatus(service.removePolicy('role-1', 'policy-1'), 428);
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-missing-credentials');
  });

  it('wrong password → 401; wrong name → 400', async () => {
    await expect(service.removePolicy('role-1', 'policy-1', { password: 'nope', confirmationName: 'team-policy' })).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.removePolicy('role-1', 'policy-1', { password: GOOD_PASSWORD, confirmationName: 'other' })).rejects.toThrow(
      BadRequestException,
    );
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
  });

  it('unknown policy → 404', async () => {
    mocks.policyRepo.findById.mockResolvedValue(null);
    await expect(service.removePolicy('role-1', 'ghost', GOOD_CREDS('ghost'))).rejects.toThrow(NotFoundException);
  });

  it('correct step-up (policy name) → detached + confirmed audit', async () => {
    await service.removePolicy('role-1', 'policy-1', GOOD_CREDS('team-policy'));
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).toHaveBeenCalledWith('role-1', 'policy-1', ADMIN_USER.id);
    const audits = breakGlassAudits(mocks);
    expect(audits[0]?.data.outcome).toBe('confirmed');
    expect(audits[0]?.data.operation).toBe('role-policy-detach');
  });

  it('system role, non-elevated caller → 403 BEFORE any break-glass prompt', async () => {
    mocks.roleRepo.findByIdGuardSelect.mockResolvedValue(SYSTEM_ROLE);
    await expect(service.removePolicy('role-sys', 'policy-1', GOOD_CREDS('team-policy'))).rejects.toThrow(ForbiddenException);
    expect(mocks.crypto.verify).not.toHaveBeenCalled();
    expect(mocks.rolePolicyRepo.softDeleteByRoleAndPolicy).not.toHaveBeenCalled();
  });
});
