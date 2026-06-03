/**
 * TASK-327 T1 / TASK-331 doc-05 F-4 — global-scope predicate.
 *
 * Per the product decision, GLOBAL_ADMIN is a full SUPER_ADMIN synonym
 * ("global admin is super admin, with no limits in any tenant"). The earlier
 * doc-04 work treated GLOBAL_ADMIN as a dead/unseeded arm and pinned it FALSE;
 * that is reversed here. `isSuperAdmin()`, `isGlobalScope()` and `isAdmin()`
 * now all accept GLOBAL_ADMIN alongside SUPER_ADMIN. A global-scope user must
 * still pick a tenant before tenant-scoped views. This test pins the
 * predicates so the synonym can't silently regress.
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

    it('is true for GLOBAL_ADMIN (SUPER_ADMIN synonym — F-4)', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isGlobalScope()).toBe(true);
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

  describe('isSuperAdmin (SUPER_ADMIN ∪ GLOBAL_ADMIN — F-4)', () => {
    it('is true for SUPER_ADMIN', () => {
      setRoles(['SUPER_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(true);
    });

    it('is true for GLOBAL_ADMIN (SUPER_ADMIN synonym — F-4)', () => {
      setRoles(['GLOBAL_ADMIN']);
      expect(useAuthStore.getState().isSuperAdmin()).toBe(true);
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

    it('is true for GLOBAL_ADMIN (SUPER_ADMIN synonym — F-4)', () => {
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
