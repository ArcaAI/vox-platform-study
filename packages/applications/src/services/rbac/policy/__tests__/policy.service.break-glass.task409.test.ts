/**
 * Policy break-glass second confirmation + hardened protected-set
 * identification.
 *
 * Matrix pinned here:
 *   1. Guard hardening — a policy is protected when `isProtected === true`
 *      OR the legacy name matches (defense in depth). A RENAMED protected
 *      policy (marker true, name unknown) still refuses deletion, disabling,
 *      and stripping of its system-critical grants.
 *   2. Absolute block — protected policies stay blocked even when a correct
 *      break-glass confirmation is supplied (standing decision: no override).
 *   3. Break-glass on dangerous-but-allowed mutations —
 *        • policy DELETE always requires step-up (password + exact name);
 *        • rule-edits require step-up only when the policy is attached to
 *          more than one ENABLED role (multi-role blast radius).
 *      Missing credentials → 428, wrong password → 401, wrong name → 400.
 *   4. `isProtected` is read-only through the API — explicit write attempts
 *      are rejected with 400 (the field never reaches the factory/Prisma).
 *   5. Audit — every confirmed mutation AND every rejected attempt emits a
 *      forced audit event that never carries the password.
 */
import { vi, describe, beforeEach, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { ResourceStatusType, SysEventType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { PolicyService } from '../policy.service';
import { RBAC_BREAK_GLASS_AUDIT_ACTION } from '../../breakGlass';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };
const STORED_HASH = 'bcrypt$stored-hash';
const GOOD_PASSWORD = 'correct-horse-battery';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-x',
    name: 'team-policy',
    description: null,
    scope: 'TENANT',
    rules: [{ action: 'read', subject: 'User' }],
    resourceStatus: ResourceStatusType.ENABLED,
    isProtected: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const SYSTEM_FULL_ACCESS = row({
  id: 'sfa',
  name: 'system-full-access',
  scope: 'GLOBAL',
  isProtected: true,
  rules: [{ action: 'manage', subject: 'all' }],
});

/** The rename-fragility case: marker true, name unknown. */
const RENAMED_PROTECTED = row({
  id: 'sfa-renamed',
  name: 'platform-root-grant',
  scope: 'GLOBAL',
  isProtected: true,
  rules: [{ action: 'manage', subject: 'all' }],
});

/** Legacy name match without the marker (e.g. DB not yet re-seeded). */
const NAME_ONLY_PROTECTED = row({
  id: 'rsm',
  name: 'rbac-system-manage',
  scope: 'GLOBAL',
  isProtected: false,
  rules: [
    { action: 'manage', subject: 'Role' },
    { action: 'manage', subject: 'Policy' },
    { action: 'manage', subject: 'RolePolicy' },
    { action: 'manage', subject: 'UserRoleAssignment' },
  ],
});

function makeMocks() {
  const cls = { get: vi.fn((k: string) => (k === 'user' ? ADMIN_USER : null)), set: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const policyRepo = {
    findMany: vi.fn(),
    count: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(undefined),
  };
  const rolePolicyRepo = { countEnabledByPolicy: vi.fn().mockResolvedValue(0) };
  const userRepo = { findById: vi.fn().mockResolvedValue({ id: ADMIN_USER.id, password: STORED_HASH }) };
  const crypto = { verify: vi.fn(async (pw: string) => pw === GOOD_PASSWORD) };
  const engine = { invalidatePolicy: vi.fn().mockResolvedValue(undefined) };
  return { cls, eventEmitter, policyRepo, rolePolicyRepo, userRepo, crypto, engine };
}

function buildService(m: ReturnType<typeof makeMocks>) {
  return new PolicyService(
    m.policyRepo as never,
    m.engine as never,
    m.rolePolicyRepo as never,
    m.userRepo as never,
    m.crypto as never,
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

describe('PolicyService protected-set hardening (isProtected OR name)', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
  });

  it('refuses to delete a RENAMED protected policy (marker survives rename)', async () => {
    mocks.policyRepo.findById.mockResolvedValue(RENAMED_PROTECTED);
    await expect(service.softDelete('sfa-renamed', GOOD_CREDS('platform-root-grant'))).rejects.toThrow(ForbiddenException);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
  });

  it('refuses to delete a name-matched policy even without the marker (legacy fallback)', async () => {
    mocks.policyRepo.findById.mockResolvedValue(NAME_ONLY_PROTECTED);
    await expect(service.softDelete('rsm', GOOD_CREDS('rbac-system-manage'))).rejects.toThrow(ForbiddenException);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
  });

  it('refuses to disable a renamed protected policy', async () => {
    mocks.policyRepo.findById.mockResolvedValue(RENAMED_PROTECTED);
    await expect(service.patch('sfa-renamed', { resourceStatus: 'DISABLED' })).rejects.toThrow(ForbiddenException);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
  });

  it('refuses to strip manage:all from a renamed protected policy (rules-derived requirement)', async () => {
    mocks.policyRepo.findById.mockResolvedValue(RENAMED_PROTECTED);
    await expect(service.update('sfa-renamed', { rules: [{ action: 'read', subject: 'User' }] })).rejects.toThrow(ForbiddenException);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
  });

  it('protected delete stays 403 even WITH a correct break-glass confirmation (absolute block)', async () => {
    mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
    await expect(service.softDelete('sfa', GOOD_CREDS('system-full-access'))).rejects.toThrow(ForbiddenException);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    const audits = breakGlassAudits(mocks);
    expect(audits.length).toBe(1);
    expect(audits[0].data.outcome).toBe('rejected-protected');
  });
});

describe('PolicyService break-glass on DELETE', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
    mocks.policyRepo.findById.mockResolvedValue(row());
  });

  it('missing credentials → 428, delete not performed, rejection audited', async () => {
    await expectStatus(service.softDelete('policy-x'), 428);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    const audits = breakGlassAudits(mocks);
    expect(audits.length).toBe(1);
    expect(audits[0].data.outcome).toBe('rejected-missing-credentials');
    expect(audits[0].forceAuditLog).toBe(true);
  });

  it('wrong password → 401 UnauthorizedException, rejection audited', async () => {
    await expect(service.softDelete('policy-x', { password: 'nope', confirmationName: 'team-policy' })).rejects.toThrow(UnauthorizedException);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-wrong-password');
  });

  it('wrong confirmationName → 400 BadRequestException, rejection audited', async () => {
    await expect(service.softDelete('policy-x', { password: GOOD_PASSWORD, confirmationName: 'not-the-name' })).rejects.toThrow(BadRequestException);
    expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-wrong-name');
  });

  it('correct password + exact name → deletes and audits the confirmed mutation', async () => {
    const result = await service.softDelete('policy-x', GOOD_CREDS('team-policy'));
    expect(result).toEqual({ id: 'policy-x', name: 'team-policy' });
    expect(mocks.policyRepo.softDelete).toHaveBeenCalledWith('policy-x', ADMIN_USER.id);
    const audits = breakGlassAudits(mocks);
    expect(audits.length).toBe(1);
    expect(audits[0].data.outcome).toBe('confirmed');
    expect(audits[0].data.operation).toBe('policy-delete');
  });

  it('audit events never contain the password and attribute the system tenant for null CLS tenant', async () => {
    await service.softDelete('policy-x', GOOD_CREDS('team-policy')).catch(() => undefined);
    const audits = breakGlassAudits(mocks);
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      expect(JSON.stringify(audit)).not.toContain(GOOD_PASSWORD);
      expect(audit.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(audit.forceAuditLog).toBe(true);
    }
  });
});

describe('PolicyService break-glass on multi-role rule edits', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
    mocks.policyRepo.findById.mockResolvedValue(row());
    mocks.policyRepo.update.mockResolvedValue(row());
  });

  it('rule-edit of a policy attached to >1 role without credentials → 428', async () => {
    mocks.rolePolicyRepo.countEnabledByPolicy.mockResolvedValue(2);
    await expectStatus(service.patch('policy-x', { rules: [{ action: 'read', subject: 'Tenant' }] }), 428);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('rejected-missing-credentials');
  });

  it('rule-edit of a policy attached to >1 role with correct step-up → updates + audits', async () => {
    mocks.rolePolicyRepo.countEnabledByPolicy.mockResolvedValue(3);
    await service.patch('policy-x', { rules: [{ action: 'read', subject: 'Tenant' }], breakGlass: GOOD_CREDS('team-policy') });
    expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    expect(breakGlassAudits(mocks)[0]?.data.outcome).toBe('confirmed');
    expect(breakGlassAudits(mocks)[0]?.data.operation).toBe('policy-rule-edit');
  });

  it('rule-edit of a policy attached to ≤1 role needs no break-glass', async () => {
    mocks.rolePolicyRepo.countEnabledByPolicy.mockResolvedValue(1);
    await service.patch('policy-x', { rules: [{ action: 'read', subject: 'Tenant' }] });
    expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    expect(breakGlassAudits(mocks).length).toBe(0);
  });

  it('non-rule edits (name/description) never require break-glass', async () => {
    mocks.rolePolicyRepo.countEnabledByPolicy.mockResolvedValue(5);
    await service.patch('policy-x', { description: 'safer description' });
    expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    expect(breakGlassAudits(mocks).length).toBe(0);
  });

  it('update() (PUT) enforces the same multi-role rule-edit break-glass', async () => {
    mocks.rolePolicyRepo.countEnabledByPolicy.mockResolvedValue(2);
    await expectStatus(service.update('policy-x', { rules: [{ action: 'read', subject: 'Tenant' }] }), 428);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
  });
});

describe('isProtected is read-only through the service', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
    mocks.policyRepo.findById.mockResolvedValue(row());
    mocks.policyRepo.update.mockResolvedValue(row());
  });

  it('explicit isProtected=false in update → 400, nothing persisted', async () => {
    await expect(service.update('policy-x', { isProtected: false } as never)).rejects.toThrow(BadRequestException);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
  });

  it('explicit isProtected=true in patch → 400, nothing persisted', async () => {
    await expect(service.patch('policy-x', { isProtected: true } as never)).rejects.toThrow(BadRequestException);
    expect(mocks.policyRepo.update).not.toHaveBeenCalled();
  });

  it('create() never forwards isProtected to the factory (server-side strip)', async () => {
    mocks.policyRepo.create.mockResolvedValue(row());
    await service.create({ name: 'p', scope: 'TENANT', rules: [{ action: 'read', subject: 'User' }], isProtected: true } as never);
    const created = mocks.policyRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.isProtected).toBeUndefined();
  });
});
