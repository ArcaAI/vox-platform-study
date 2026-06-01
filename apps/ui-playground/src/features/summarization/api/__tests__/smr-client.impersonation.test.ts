import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { smrClient } from '../smr-client';

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

/**
 * D2 (TASK-323) — SMR requests must carry the *effective* (impersonated)
 * tenant + token, identically to `adminClient`. A TENANT_ADMIN/SUPER_ADMIN
 * impersonating a user in another tenant must generate summaries in the
 * impersonated tenant, never their own.
 */
describe('smrClient.getHeaders — impersonation tenant + token (D2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.getState().logout();
    usePlaygroundStore.getState().setApiBaseUrl(BASE_URL);
  });

  it('uses the base access token + base tenant when NOT impersonating', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', adminUser, ADMIN_TENANT, 'acme', 'refresh');

    const headers = smrClient.getHeaders() as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer admin-token');
    expect(headers['X-Tenant-Id']).toBe(ADMIN_TENANT);
  });

  it('uses the impersonation token + impersonated tenant while impersonating', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', adminUser, ADMIN_TENANT, 'acme', 'refresh');
    useAuthStore.getState().startImpersonation(doctorUser, 'imp-token', DOCTOR_TENANT);

    const headers = smrClient.getHeaders() as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer imp-token');
    expect(headers['X-Tenant-Id']).toBe(DOCTOR_TENANT);
  });

  it('restores the base token + tenant after impersonation ends', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', adminUser, ADMIN_TENANT, 'acme', 'refresh');
    useAuthStore.getState().startImpersonation(doctorUser, 'imp-token', DOCTOR_TENANT);
    useAuthStore.getState().endImpersonation();

    const headers = smrClient.getHeaders() as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer admin-token');
    expect(headers['X-Tenant-Id']).toBe(ADMIN_TENANT);
  });

  it('uses X-API-Key (no bearer) for apiKey auth', () => {
    useAuthStore.getState().setApiKeyAuth('secret-key', ADMIN_TENANT);

    const headers = smrClient.getHeaders() as Record<string, string>;

    expect(headers['X-API-Key']).toBe('secret-key');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBe(ADMIN_TENANT);
  });
});
