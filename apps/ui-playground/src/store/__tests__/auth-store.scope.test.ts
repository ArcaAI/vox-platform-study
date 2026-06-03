/**
 * TASK-327 T1 / TASK-331 #7 — global-scope predicate.
 *
 * "Global scope" is SUPER_ADMIN ONLY. The earlier GLOBAL_ADMIN role was never
 * seeded, so the predicate arm that accepted it was dead code and has been
 * removed. A global-scope user must pick a tenant before tenant-scoped views.
 * `isSuperAdmin()` stays STRICT (only SUPER_ADMIN) — it gates super-admin-only
 * surfaces (e.g. Prisma Studio). This test pins the predicates and guards
 * against the unseeded GLOBAL_ADMIN role silently re-acquiring admin scope.
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

    it('is false for the unseeded GLOBAL_ADMIN role (dead arm removed)', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });

    it('is true when SUPER_ADMIN is present alongside other roles', () => {
      setRoles(['SUPER_ADMIN', 'DOCTOR']);
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

  // `isAdmin` is the role-level gate for *any* admin surface — the same
  // predicate the sidebar/nav use (TASK-327 "scope, not visibility"). It is
  // deliberately broader than `isGlobalScope`: a TENANT_ADMIN is an admin
  // (data is tenant-scoped server-side) but is NOT global scope.
  describe('isAdmin (SUPER_ADMIN ∪ TENANT_ADMIN)', () => {
    it('is true for SUPER_ADMIN', () => {
      setRoles(['SUPER_ADMIN']);
      expect(useAuthStore.getState().isAdmin()).toBe(true);
    });

    it('is false for the unseeded GLOBAL_ADMIN role (dead arm removed)', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });

    it('is true for TENANT_ADMIN', () => {
      setRoles(['TENANT_ADMIN']);
      expect(useAuthStore.getState().isAdmin()).toBe(true);
    });

    it('is false for a non-admin clinical role', () => {
      setRoles(['DOCTOR']);
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });

    it('is false when there is no user', () => {
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });

    it('is false for an empty roles array', () => {
      setRoles([]);
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });
  });
});
