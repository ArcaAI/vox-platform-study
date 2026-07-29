import { useAuthStore } from '@/store/auth-store';

const mockRefreshToken = vi.fn();
const mockSetOnUnauthorized = vi.fn();
const mockUpdateAccessToken = vi.fn();
const mockApiClient = {
  setOnUnauthorized: mockSetOnUnauthorized,
  updateAccessToken: mockUpdateAccessToken,
};

vi.mock('@arcaai/vox', () => ({
  useAuth: () => ({ refreshToken: mockRefreshToken }),
  useArcaStore: (selector?: (s: { apiClient: typeof mockApiClient }) => unknown) => {
    const state = { apiClient: mockApiClient };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/auth-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-refresh')>();
  return {
    ...actual,
    tryRefreshToken: vi.fn(),
  };
});

import { renderHook } from '@testing-library/react';
import { useAutoRefresh } from '../use-auto-refresh';
import { tryRefreshToken } from '@/lib/auth-refresh';

const mockUser = {
  id: 'u-1',
  email: 'test@test.com',
  username: 'tester',
  roles: ['admin'],
  permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

function createJwt(expInSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + expInSeconds;
  const payload = btoa(JSON.stringify({ id: 'u-1', exp }));
  return `${header}.${payload}.fake-sig`;
}

describe('useAutoRefresh — proactive timer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should schedule a proactive refresh at 80% of token lifetime', () => {
    const token = createJwt(3600);
    useAuthStore.getState().setCredentialsAuth(token, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    renderHook(() => useAutoRefresh());

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(true);

    vi.advanceTimersByTime(2_880_000);

    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('should not schedule proactive refresh for apiKey auth', () => {
    useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);

    renderHook(() => useAutoRefresh());

    vi.advanceTimersByTime(10_000_000);

    expect(tryRefreshToken).not.toHaveBeenCalled();
  });

  it('should not schedule proactive refresh when token has no expiry', () => {
    useAuthStore.getState().setCredentialsAuth('not-a-jwt', mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    renderHook(() => useAutoRefresh());

    vi.advanceTimersByTime(10_000_000);

    expect(tryRefreshToken).not.toHaveBeenCalled();
  });

  it('should clear timer on unmount', () => {
    const token = createJwt(3600);
    useAuthStore.getState().setCredentialsAuth(token, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    const { unmount } = renderHook(() => useAutoRefresh());
    unmount();

    vi.advanceTimersByTime(10_000_000);

    expect(tryRefreshToken).not.toHaveBeenCalled();
  });

  it('should immediately refresh when token is already expired on mount', async () => {
    const expiredToken = createJwt(-60);
    useAuthStore.getState().setCredentialsAuth(expiredToken, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(true);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('should not immediately refresh expired token when no refresh token is stored', async () => {
    const expiredToken = createJwt(-60);
    useAuthStore.getState().setCredentialsAuth(expiredToken, mockUser, TENANT_UUID);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(tryRefreshToken).not.toHaveBeenCalled();
  });

  it('should not immediately refresh expired token for apiKey auth', async () => {
    useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(tryRefreshToken).not.toHaveBeenCalled();
  });

  it('should logout when immediate refresh of expired token fails', async () => {
    const expiredToken = createJwt(-60);
    useAuthStore.getState().setCredentialsAuth(expiredToken, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(false);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('should call tryRefreshToken on immediate refresh of expired token', async () => {
    const expiredToken = createJwt(-60);
    useAuthStore.getState().setCredentialsAuth(expiredToken, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(true);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('should call tryRefreshToken on proactive timer refresh', async () => {
    const token = createJwt(3600);
    useAuthStore.getState().setCredentialsAuth(token, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    renderHook(() => useAutoRefresh());

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(true);

    await vi.advanceTimersByTimeAsync(2_880_000);

    expect(tryRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('should not update SDK apiClient when refresh fails', async () => {
    const expiredToken = createJwt(-60);
    useAuthStore.getState().setCredentialsAuth(expiredToken, mockUser, TENANT_UUID, 'acme', 'refresh_u1_123_abc');

    vi.mocked(tryRefreshToken).mockResolvedValueOnce(false);

    renderHook(() => useAutoRefresh());

    await vi.advanceTimersByTimeAsync(0);

    expect(mockUpdateAccessToken).not.toHaveBeenCalled();
  });
});
