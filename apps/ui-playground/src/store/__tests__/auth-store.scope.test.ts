/**
 * TASK-327 T1 / TASK-331 doc-05 F-4 / TASK-417 — global-scope predicate.
 *
 * TASK-417 consolidated the legacy SUPER_ADMIN into GLOBAL_ADMIN: it is the
 * single elevated role, and the retired SUPER_ADMIN literal must no longer
 * elevate. `isSuperAdmin()`, `isGlobalScope()` and `isAdmin()` accept
 * GLOBAL_ADMIN (isAdmin also TENANT_ADMIN). A global-scope user must
 * still pick a tenant before tenant-scoped views. This test pins the
 * predicates so the consolidation can't silently regress.
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
    it('is true for GLOBAL_ADMIN', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(true);
    });

    it('is false for the retired SUPER_ADMIN literal (TASK-417)', () => {
      setRoles(['SUPER_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(false);
    });

    it('is true when GLOBAL_ADMIN is present alongside other roles', () => {
      setRoles(['GLOBAL_ADMIN', 'DOCTOR']);
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

  describe('isSuperAdmin (GLOBAL_ADMIN — TASK-417)', () => {
    it('is true for GLOBAL_ADMIN', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(true);
    });

    it('is false for the retired SUPER_ADMIN literal (TASK-417)', () => {
      setRoles(['SUPER_ADMIN']);
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
  describe('isAdmin (GLOBAL_ADMIN ∪ TENANT_ADMIN)', () => {
    it('is true for GLOBAL_ADMIN', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isAdmin()).toBe(true);
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
