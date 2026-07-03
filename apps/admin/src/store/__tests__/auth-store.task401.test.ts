/**
 * auth-store — TASK-401 impersonation slice.
 *
 * Contract: `startImpersonation` swaps the ACTIVE session to the impersonated
 * one (access token only — refresh cleared so auto-refresh no-ops) while
 * snapshotting the original session for restore; `endImpersonation` restores
 * it and hands back the `returnTo` path. Nested starts are ignored so the
 * original snapshot can never be overwritten by a second start.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore, type AuthUser } from '../auth-store';

const SUPER_ADMIN: AuthUser = {
  id: 'admin-1',
  email: 'root@arcaai.com',
  username: 'superadmin',
  roles: ['SUPER_ADMIN'],
  permissions: ['manage:all'],
};

const DOCTOR_SESSION = {
  token: 'impersonation.jwt.token',
  user: {
    id: 'doctor-1',
    email: 'doctor@clinic.test',
    username: 'doctor',
    roles: ['DOCTOR'],
    permissions: ['read:consultation'],
    tenantId: 'tenant-clinic',
  },
  expiresAt: '2026-07-02T14:00:00.000Z',
  returnTo: '/tenants/tenant-clinic/users/doctor-1',
};

function seedSuperAdminSession() {
  useAuthStore.getState().setCredentialsAuth('admin.jwt', SUPER_ADMIN, 'tenant-system', 'system-key', 'admin.refresh');
}

describe('auth-store — TASK-401 impersonation slice', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().logout();
    seedSuperAdminSession();
  });

  it('startImpersonation swaps the active session and snapshots the original', () => {
    useAuthStore.getState().startImpersonation(DOCTOR_SESSION);

    const s = useAuthStore.getState();
    expect(s.accessToken).toBe('impersonation.jwt.token');
    expect(s.refreshToken).toBe(''); // non-refreshable: auto-refresh must no-op
    expect(s.tenantId).toBe('tenant-clinic');
    expect(s.user?.id).toBe('doctor-1');
    expect(s.user?.roles).toEqual(['DOCTOR']);
    expect(s.isAuthenticated).toBe(true);

    expect(s.impersonation.active).toBe(true);
    expect(s.impersonation.expiresAt).toBe('2026-07-02T14:00:00.000Z');
    expect(s.impersonation.targetName).toBe('doctor');
    expect(s.impersonation.original?.accessToken).toBe('admin.jwt');
    expect(s.impersonation.original?.refreshToken).toBe('admin.refresh');
    expect(s.impersonation.original?.user.id).toBe('admin-1');
    expect(s.impersonation.original?.returnTo).toBe('/tenants/tenant-clinic/users/doctor-1');
  });

  it('a second start while active is ignored (nested impersonation cannot clobber the snapshot)', () => {
    useAuthStore.getState().startImpersonation(DOCTOR_SESSION);
    useAuthStore.getState().startImpersonation({
      ...DOCTOR_SESSION,
      token: 'second.jwt',
      user: { ...DOCTOR_SESSION.user, id: 'nurse-9', username: 'nurse' },
    });

    const s = useAuthStore.getState();
    expect(s.accessToken).toBe('impersonation.jwt.token');
    expect(s.user?.id).toBe('doctor-1');
    expect(s.impersonation.original?.user.id).toBe('admin-1');
  });

  it('endImpersonation restores the original session and returns the returnTo path', () => {
    useAuthStore.getState().startImpersonation(DOCTOR_SESSION);
    const returnTo = useAuthStore.getState().endImpersonation();

    expect(returnTo).toBe('/tenants/tenant-clinic/users/doctor-1');
    const s = useAuthStore.getState();
    expect(s.accessToken).toBe('admin.jwt');
    expect(s.refreshToken).toBe('admin.refresh');
    expect(s.tenantId).toBe('tenant-system');
    expect(s.tenantKey).toBe('system-key');
    expect(s.user?.id).toBe('admin-1');
    expect(s.user?.roles).toEqual(['SUPER_ADMIN']);
    expect(s.impersonation.active).toBe(false);
    expect(s.impersonation.original).toBeNull();
  });

  it('endImpersonation when not impersonating is a no-op returning null', () => {
    const returnTo = useAuthStore.getState().endImpersonation();
    expect(returnTo).toBeNull();
    expect(useAuthStore.getState().accessToken).toBe('admin.jwt');
  });

  it('logout clears the impersonation slice too', () => {
    useAuthStore.getState().startImpersonation(DOCTOR_SESSION);
    useAuthStore.getState().logout();

    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.accessToken).toBe('');
    expect(s.impersonation.active).toBe(false);
    expect(s.impersonation.original).toBeNull();
  });
});
