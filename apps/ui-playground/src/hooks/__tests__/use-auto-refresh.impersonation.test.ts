/**
 * useAutoRefresh — Impersonation-aware 401 handling (TASK-235)
 *
 * When impersonating, an expired impersonation token cannot be refreshed
 * via the normal refresh endpoint (which only returns base-user tokens).
 * The handler must: refresh the base token, re-impersonate the target user
 * to get a fresh impersonation token, and update AgenticClient accordingly.
 *
 * @vitest-environment jsdom
 */

import { useAuthStore } from '@/store/auth-store';

const mockUpdateAccessToken = vi.fn();
const mockSetOnUnauthorized = vi.fn();
const mockPostFn = vi.fn();
const mockGetAccessToken = vi.fn();
const mockApiClient = {
    setOnUnauthorized: mockSetOnUnauthorized,
    updateAccessToken: mockUpdateAccessToken,
    post: mockPostFn,
    getAccessToken: mockGetAccessToken,
};

vi.mock('@arcaai/vox', () => ({
    useAuth: () => ({ refreshToken: vi.fn() }),
    useAgenticStore: () => ({ apiClient: mockApiClient }),
}));

import { renderHook, cleanup } from '@testing-library/react';
import { useAutoRefresh } from '../use-auto-refresh';

const mockSuperAdmin = {
    id: '70000000-0000-0000-0000-000000000001',
    email: 'admin@test.com',
    username: 'super_admin',
    roles: ['SUPER_ADMIN'],
    permissions: [],
};

const mockDoctor = {
    id: '70000000-0000-0000-0000-000000000010',
    email: 'doctor@test.com',
    username: 'doctor',
    roles: ['DOCTOR'],
    permissions: [],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('useAutoRefresh — impersonation 401 handling (TASK-235)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    afterEach(() => {
        cleanup();
    });

    it('should refresh base token then re-impersonate when 401 occurs during impersonation', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'admin-access-token',
            mockSuperAdmin,
            TENANT_UUID,
            'acme',
            'refresh_admin_123_abc',
        );
        useAuthStore.getState().startImpersonation(mockDoctor, 'expired-impersonation-token');

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'fresh-admin-token', refreshToken: 'new-refresh' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        mockPostFn.mockResolvedValueOnce({
            user: mockDoctor,
            token: 'fresh-impersonation-token',
            impersonatedBy: mockSuperAdmin.id,
        });

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(result).toBe(true);

        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/auth/refresh'),
            expect.objectContaining({ method: 'POST' }),
        );

        expect(mockPostFn).toHaveBeenCalledWith(
            '/auth/impersonate',
            { targetUserId: mockDoctor.id },
        );

        expect(mockUpdateAccessToken).toHaveBeenCalledWith('fresh-impersonation-token');

        expect(useAuthStore.getState().impersonationToken).toBe('fresh-impersonation-token');

        fetchSpy.mockRestore();
    });

    it('should end impersonation and fall back to admin token when re-impersonation fails', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'admin-access-token',
            mockSuperAdmin,
            TENANT_UUID,
            'acme',
            'refresh_admin_123_abc',
        );
        useAuthStore.getState().startImpersonation(mockDoctor, 'expired-impersonation-token');

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'fresh-admin-token', refreshToken: 'new-refresh' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        mockPostFn.mockRejectedValueOnce(new Error('Impersonation failed'));

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(result).toBe(true);
        expect(useAuthStore.getState().isImpersonating).toBe(false);
        expect(mockUpdateAccessToken).toHaveBeenCalledWith('fresh-admin-token');

        fetchSpy.mockRestore();
    });

    it('should logout when base token refresh fails during impersonation', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'admin-access-token',
            mockSuperAdmin,
            TENANT_UUID,
            'acme',
            'refresh_admin_123_abc',
        );
        useAuthStore.getState().startImpersonation(mockDoctor, 'expired-impersonation-token');

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

    it('should use normal refresh flow when NOT impersonating', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockSuperAdmin,
            TENANT_UUID,
            'acme',
            'refresh_admin_123_abc',
        );

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        renderHook(() => useAutoRefresh());

        const handler = mockSetOnUnauthorized.mock.calls[0][0];
        const result = await handler();

        expect(result).toBe(true);
        expect(mockPostFn).not.toHaveBeenCalled();
        expect(useAuthStore.getState().accessToken).toBe('new-access');

        fetchSpy.mockRestore();
    });
});
