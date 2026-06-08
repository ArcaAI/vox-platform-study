import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { adminClient } from '../admin-client';

/**
 * TASK-340 — Impersonation must not block administration interfaces.
 *
 * `adminClient` serves BOTH admin-plane routes (`/admin/*`) and a few
 * user-plane routes (e.g. `/dna-writing-styles/*`). While impersonating,
 * admin-plane requests must carry the admin's OWN token (so RBAC sees the
 * admin's roles), while user-plane requests keep the impersonation token (so
 * playground features act as the impersonated end-user).
 */
const ADMIN_TENANT = '50000000-0000-0000-0000-000000000001';
const DOCTOR_TENANT = '50000000-0000-0000-0000-0000000000a2';
const BASE_URL = 'http://localhost:8868/api/v1';

const adminUser = {
  id: 'admin-1',
  email: 'admin@test.com',
  username: 'admin',
  roles: ['TENANT_ADMIN'],
  permissions: [],
};

const doctorUser = {
  id: 'doctor-1',
  email: 'doctor@test.com',
  username: 'doctor',
  roles: ['DOCTOR'],
  permissions: [],
};

function authHeaderOf(fetchSpy: ReturnType<typeof vi.spyOn>, callIndex = 0): string | undefined {
  const init = fetchSpy.mock.calls[callIndex]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.['Authorization'];
}

function arrangeOk(fetchSpy: ReturnType<typeof vi.spyOn>) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [], count: 0, page: 1, limit: 20 }), { status: 200 }));
}

describe('adminClient — TASK-340 admin-plane token routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    useAuthStore.getState().logout();
    usePlaygroundStore.getState().setApiBaseUrl(BASE_URL);
    useAuthStore.getState().setCredentialsAuth('admin-token', adminUser, ADMIN_TENANT, 'acme', 'refresh');
  });

  describe('while impersonating', () => {
    beforeEach(() => {
      useAuthStore.getState().startImpersonation(doctorUser, 'imp-token', DOCTOR_TENANT);
    });

    it('uses the ADMIN token for an admin-plane request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/admin/tenants');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });

    it('uses the IMPERSONATION token for a user-plane request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/dna-writing-styles/mine');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer imp-token');
    });

    it('uses the ADMIN token for an admin-plane multipart upload', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.upload('/admin/tenants/import', new FormData());

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });
  });

  describe('when NOT impersonating (unchanged behavior)', () => {
    it('uses the access token for an admin-plane request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/admin/tenants');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });
  });
});
