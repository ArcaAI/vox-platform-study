/**
 * useAutoRefresh — TASK-234 tests (updated for TASK-235 unified refresh path)
 *
 * After TASK-235, handleUnauthorized delegates to tryRefreshToken() instead of
 * calling the SDK's refreshToken() directly. These tests verify the same
 * observable behaviors through the new path.
 */

import { useAuthStore } from '@/store/auth-store';

const mockSetOnUnauthorized = vi.fn();
const mockUpdateAccessToken = vi.fn();
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

import { renderHook } from '@testing-library/react';
import { useAutoRefresh } from '../use-auto-refresh';

const mockUser = {
    id: 'u-1',
    email: 'test@test.com',
    username: 'tester',
    roles: ['admin'],
    permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('useAutoRefresh — TASK-234', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    it('should register an onUnauthorized handler on the apiClient', () => {
        useAuthStore.getState().setCredentialsAuth(
            'access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        renderHook(() => useAutoRefresh());
        expect(mockSetOnUnauthorized).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should call /auth/refresh and update tokens when 401 fires', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'new-access', refreshToken: 'refresh_u1_456_def' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/auth/refresh'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ refreshToken: 'refresh_u1_123_abc' }),
            }),
        );
        expect(result).toBe(true);

        fetchSpy.mockRestore();
    });

    it('should update playground auth store with new tokens after refresh', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'new-access-token', refreshToken: 'new-refresh-token' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        await handler();

        expect(useAuthStore.getState().accessToken).toBe('new-access-token');
        expect(useAuthStore.getState().refreshToken).toBe('new-refresh-token');

        fetchSpy.mockRestore();
    });

    it('should return false when no refresh token is stored', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'access',
            mockUser,
            TENANT_UUID,
        );

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(result).toBe(false);
    });

    it('should return false and logout when refresh fails', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Invalid' }), { status: 401 }),
        );

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(result).toBe(false);
        expect(useAuthStore.getState().isAuthenticated).toBe(false);

        fetchSpy.mockRestore();
    });

    it('should not register handler when authMethod is apiKey', () => {
        useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);

        renderHook(() => useAutoRefresh());

        expect(mockSetOnUnauthorized).not.toHaveBeenCalled();
    });
});
