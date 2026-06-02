/**
 * TASK-327 T1 — global-scope predicate.
 *
 * D1: SUPER_ADMIN and GLOBAL_ADMIN share the same "global scope". A
 * global-scope user must pick a tenant before tenant-scoped views.
 * `isSuperAdmin()` stays STRICT (only SUPER_ADMIN) — it gates
 * super-admin-only surfaces (e.g. Prisma Studio). This test pins both
 * predicates so they don't silently collapse into each other.
 */
import { useAuthStore } from '../auth-store';

const baseUser = {
  id: 'u-1',
  email: 'test@example.com',
  username: 'tester',
  permissions: [] as string[],
};

function setRoles(roles: string[]) {
  useAuthStore.getState().setCredentialsAuth('token', { ...baseUser, roles }, '50000000-0000-0000-0000-000000000001');
}

describe('auth-store scope predicates (TASK-327 T1)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  describe('isGlobalScope', () => {
    it('is true for SUPER_ADMIN', () => {
      setRoles(['SUPER_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(true);
    });

    it('is true for GLOBAL_ADMIN', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(true);
    });

    it('is true when both global roles are present', () => {
      setRoles(['SUPER_ADMIN', 'GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(true);
    });

    it('is false for TENANT_ADMIN', () => {
      setRoles(['TENANT_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });

    it('is false for a non-admin role', () => {
      setRoles(['DOCTOR']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });

    it('is false when there is no user', () => {
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });

    it('is false for an empty roles array', () => {
      setRoles([]);
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });
  });

  describe('isSuperAdmin stays strict (regression guard)', () => {
    it('is true only for SUPER_ADMIN', () => {
      setRoles(['SUPER_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(true);
    });

    it('is false for GLOBAL_ADMIN', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(false);
    });

    it('is false for TENANT_ADMIN', () => {
      setRoles(['TENANT_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(false);
    });
  });
});
