import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { adminClient } from '../admin-client';

/**
 * TASK-353 — Admin-only routes OUTSIDE the `/admin/` prefix must carry the
 * admin's OWN token during impersonation.
 *
 * The /admin/system-health page calls `/monitoring/uptime`,
 * `/monitoring/sessions` and `/health/services` — all gated behind
 * `@Authorize(['manage', 'all'])` on the backend (TASK-336 OB-12) but NOT
 * under the `/admin/` prefix. TASK-340's predicate missed them, so while
 * impersonating a doctor every system-health call sent the doctor's JWT and
 * got a 403.
 */
const ADMIN_TENANT = '50000000-0000-0000-0000-000000000001';
const DOCTOR_TENANT = '50000000-0000-0000-0000-0000000000a2';
const BASE_URL = 'http://localhost:8868/api/v1';

const adminUser = {
  id: 'admin-1',
  email: 'admin@test.com',
  username: 'admin',
  roles: ['GLOBAL_ADMIN'],
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
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ services: {}, refreshedAt: '' }), { status: 200 }));
}

describe('adminClient — TASK-353 non-/admin admin-only token routing', () => {
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

    it('uses the ADMIN token for /monitoring/uptime', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/monitoring/uptime');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });

    it('uses the ADMIN token for /monitoring/sessions', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/monitoring/sessions');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });

    it('uses the ADMIN token for /health/services', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/health/services');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });

    it('keeps the IMPERSONATION token for a user-plane request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/dna-writing-styles/mine');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer imp-token');
    });
  });

  describe('when NOT impersonating (unchanged behavior)', () => {
    it('uses the access token for /monitoring/uptime', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      arrangeOk(fetchSpy);

      await adminClient.get('/monitoring/uptime');

      expect(authHeaderOf(fetchSpy)).toBe('Bearer admin-token');
    });
  });
});
