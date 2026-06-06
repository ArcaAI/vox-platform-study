import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { adminClient, AdminApiError } from '../admin-client';

// AC-09 (TASK-336): the 401 path silently ended impersonation and retried as the
// admin. Mock sonner's toast so we can assert an explicit, user-visible notice
// is raised when that auto-end happens.
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

import { toast } from 'sonner';

const mockUser = {
  id: 'u-1',
  email: 'admin@test.com',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  permissions: ['read'],
};

const impersonatedUser = {
  id: 'doc-9',
  email: 'bob@test.com',
  username: 'dr.bob',
  roles: ['doctor'],
  permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';
const BASE_URL = 'http://localhost:8868/api/v1';

function arrangeFailedRefresh() {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Invalid refresh token' }), { status: 401 }));
}

describe('adminClient — AC-09 impersonation auto-end notice on 401', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.warning).mockClear();
    sessionStorage.clear();
    useAuthStore.getState().logout();
    usePlaygroundStore.getState().setApiBaseUrl(BASE_URL);
    useAuthStore.getState().setCredentialsAuth('expired-token', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123');
  });

  it('surfaces a toast notice and ends impersonation when an impersonated request 401s', async () => {
    useAuthStore.getState().startImpersonation(impersonatedUser, 'imp-token');
    expect(useAuthStore.getState().isImpersonating).toBe(true);
    arrangeFailedRefresh();

    await expect(adminClient.get('/admin/users')).rejects.toThrow(AdminApiError);

    expect(useAuthStore.getState().isImpersonating).toBe(false);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('does NOT show the impersonation notice for a non-impersonated 401', async () => {
    expect(useAuthStore.getState().isImpersonating).toBe(false);
    arrangeFailedRefresh();

    await expect(adminClient.get('/admin/users')).rejects.toThrow(AdminApiError);

    expect(toast.warning).not.toHaveBeenCalled();
  });
});
