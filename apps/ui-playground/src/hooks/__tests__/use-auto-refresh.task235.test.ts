/**
 * useAutoRefresh — Unified refresh path tests (TASK-235)
 *
 * Verifies that the 401 handler uses tryRefreshToken() (the shared mutex path)
 * and that the AgenticClient is registered as a listener so it receives the
 * new token after any refresh — whether triggered by the SDK or direct clients.
 *
 * @vitest-environment jsdom
 */

import { useAuthStore } from '@/store/auth-store';

const mockUpdateAccessToken = vi.fn();
const mockSetOnUnauthorized = vi.fn();
const mockApiClient = {
  setOnUnauthorized: mockSetOnUnauthorized,
  updateAccessToken: mockUpdateAccessToken,
};

vi.mock('@arcaai/vox', () => ({
  useAuth: () => ({ refreshToken: vi.fn() }),
  useArcaStore: (selector?: (s: { apiClient: typeof mockApiClient }) => unknown) => {
    const state = { apiClient: mockApiClient };
    return selector ? selector(state) : state;
  },
}));

import { renderHook, cleanup } from '@testing-library/react';
import { useAutoRefresh } from '../use-auto-refresh';

const mockUser = {
  id: 'u-1',
  email: 'test@test.com',
  username: 'tester',
  roles: ['admin'],
  permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('useAutoRefresh — unified refresh (TASK-235)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  afterEach(() => {
    cleanup();
  });

  it('should use tryRefreshToken for 401 handling (not SDK refreshToken directly)', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderHook(() => useAutoRefresh());

    const handler = mockSetOnUnauthorized.mock.calls[0][0];
    const result = await handler();

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh_u1_123_abc' }),
      }),
    );
    expect(useAuthStore.getState().accessToken).toBe('new-access');
    expect(useAuthStore.getState().refreshToken).toBe('new-refresh');

    fetchSpy.mockRestore();
  });

  it('should sync the new token to AgenticClient via the listener after 401 refresh', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'synced-token', refreshToken: 'new-rt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderHook(() => useAutoRefresh());

    const handler = mockSetOnUnauthorized.mock.calls[0][0];
    await handler();

    expect(mockUpdateAccessToken).toHaveBeenCalledWith('synced-token');

    fetchSpy.mockRestore();
  });

  it('should return false and logout when tryRefreshToken fails in 401 handler', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Invalid' }), { status: 401 }));

    renderHook(() => useAutoRefresh());

    const handler = mockSetOnUnauthorized.mock.calls[0][0];
    const result = await handler();

    expect(result).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    fetchSpy.mockRestore();
  });

  it('should return false when no refresh token is stored', async () => {
    useAuthStore.getState().setCredentialsAuth('access', mockUser, TENANT_UUID);

    renderHook(() => useAutoRefresh());

    const handler = mockSetOnUnauthorized.mock.calls[0][0];
    const result = await handler();

    expect(result).toBe(false);
  });

  it('should unregister the listener on unmount', async () => {
    useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const { unmount } = renderHook(() => useAutoRefresh());
    unmount();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'after-unmount', refreshToken: 'new-rt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Trigger a refresh after unmount — listener should NOT fire
    const { tryRefreshToken } = await import('@/lib/auth-refresh');
    await tryRefreshToken();

    expect(mockUpdateAccessToken).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
