import { describe, expect, it } from 'vitest';
import { toSafeSession } from '../safe-user';
import type { SessionPayload } from '../session';

const operator: SessionPayload = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: {
    id: 'admin-1',
    username: 'super_admin',
    email: 'super_admin@example.com',
    roles: ['SUPER_ADMIN'],
  },
};

const tenantAdmin: SessionPayload = {
  accessToken: 'access-2',
  refreshToken: 'refresh-2',
  user: {
    id: 'tenant-admin-1',
    username: 'tenant_admin',
    email: 'tenant_admin@example.com',
    roles: ['TENANT_ADMIN'],
    tenantId: '50000000-0000-0000-0000-000000000000',
  },
};

describe('toSafeSession — effective identity', () => {
  it('when not impersonating, effectiveUser mirrors the base operator user', () => {
    const safe = toSafeSession({ ...operator, workingTenantId: '50000000-0000-0000-0000-000000000000' });

    expect(safe.effectiveUser).toEqual({
      id: 'admin-1',
      username: 'super_admin',
      email: 'super_admin@example.com',
      roles: ['SUPER_ADMIN'],
      tenantId: null,
      departmentId: null,
    });
    expect(safe.effectiveIsElevated).toBe(true);
    // Not impersonating: effective tenant scope is the operator's own working-tenant pick.
    expect(safe.effectiveTenantId).toBe('50000000-0000-0000-0000-000000000000');
  });

  it('when not impersonating and no working tenant is picked, effectiveTenantId is null', () => {
    const safe = toSafeSession(operator);
    expect(safe.effectiveTenantId).toBeNull();
  });

  it('a tenant-bound non-elevated user is their own effective identity regardless of workingTenantId', () => {
    const safe = toSafeSession(tenantAdmin);

    expect(safe.effectiveUser).toEqual({
      id: 'tenant-admin-1',
      username: 'tenant_admin',
      email: 'tenant_admin@example.com',
      roles: ['TENANT_ADMIN'],
      tenantId: '50000000-0000-0000-0000-000000000000',
      departmentId: null,
    });
    expect(safe.effectiveIsElevated).toBe(false);
    // TASK-954 — a tenant-bound user's effective scope IS its own tenant. It
    // never has a working tenant, and `null` here sent every tenant-scoped
    // screen to the SYSTEM tier (403 on every provider card).
    expect(safe.effectiveTenantId).toBe('50000000-0000-0000-0000-000000000000');
  });

  it('a tenant-bound user with a stale workingTenantId on the cookie still resolves to its own tenant', () => {
    // Sealed by an elevated session that was later downgraded — the proxy never
    // sends X-Tenant-Id for a non-elevated user, so the screens must not either.
    const safe = toSafeSession({ ...tenantAdmin, workingTenantId: '60000000-0000-0000-0000-000000000000' });
    expect(safe.effectiveTenantId).toBe('50000000-0000-0000-0000-000000000000');
  });

  it('while impersonating, effectiveUser/effectiveIsElevated/effectiveTenantId reflect the target, not the operator', () => {
    const impersonating: SessionPayload = {
      ...operator,
      // A working tenant picked by the operator BEFORE impersonating must
      // NOT leak into the effective scope while impersonating.
      workingTenantId: '60000000-0000-0000-0000-000000000000',
      impersonation: {
        accessToken: 'impersonation-token',
        originalAccessToken: operator.accessToken,
        originalRefreshToken: operator.refreshToken,
        targetUserId: 'doctor2-id',
        targetUsername: 'doctor2',
        targetEmail: 'doctor2@example.com',
        targetRoles: ['DOCTOR'],
        targetTenantId: '50000000-0000-0000-0000-000000000000',
        targetDepartmentId: 'dept-cardiology',
      },
    };

    const safe = toSafeSession(impersonating);

    expect(safe.effectiveUser).toEqual({
      id: 'doctor2-id',
      username: 'doctor2',
      email: 'doctor2@example.com',
      roles: ['DOCTOR'],
      tenantId: '50000000-0000-0000-0000-000000000000',
      departmentId: 'dept-cardiology',
    });
    expect(safe.effectiveIsElevated).toBe(false);
    expect(safe.effectiveTenantId).toBe('50000000-0000-0000-0000-000000000000');

    // Operator-facing chrome fields stay unchanged (persona-control, banner).
    expect(safe.user.username).toBe('super_admin');
    expect(safe.isElevated).toBe(true);
    expect(safe.impersonatingUserId).toBe('doctor2-id');
    expect(safe.impersonatingUsername).toBe('doctor2');
  });

  it('tolerates an impersonation state sealed before the effective-identity fields existed', () => {
    const legacyImpersonating: SessionPayload = {
      ...operator,
      impersonation: {
        accessToken: 'impersonation-token',
        originalAccessToken: operator.accessToken,
        originalRefreshToken: operator.refreshToken,
        targetUserId: 'doctor2-id',
        targetUsername: 'doctor2',
        // targetEmail/targetRoles/targetTenantId/targetDepartmentId absent (pre-Phase-0 cookie).
      },
    };

    const safe = toSafeSession(legacyImpersonating);

    expect(safe.effectiveUser).toEqual({
      id: 'doctor2-id',
      username: 'doctor2',
      email: '',
      roles: [],
      tenantId: null,
      departmentId: null,
    });
    expect(safe.effectiveIsElevated).toBe(false);
    expect(safe.effectiveTenantId).toBeNull();
  });
});
