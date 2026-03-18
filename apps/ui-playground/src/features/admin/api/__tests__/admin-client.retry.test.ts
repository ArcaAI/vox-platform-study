import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { adminClient, AdminApiError } from '../admin-client';

const mockUser = {
    id: 'u-1',
    email: 'test@test.com',
    username: 'tester',
    roles: ['admin'],
    permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';
const BASE_URL = 'http://localhost:8868/api/v1';

describe('adminClient — 401 retry with token refresh', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        useAuthStore.getState().logout();
        usePlaygroundStore.getState().setApiBaseUrl(BASE_URL);

        useAuthStore.getState().setCredentialsAuth(
            'expired-token',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );
    });

    it('should retry a GET request after refreshing token on 401', async () => {
        const mockFetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ data: 'success' }), { status: 200 }),
            );

        const result = await adminClient.get<{ data: string }>('/users');

        expect(result).toEqual({ data: 'success' });
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(useAuthStore.getState().accessToken).toBe('new-access');
    });

    it('should throw AdminApiError when refresh also fails', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'Invalid refresh token' }), { status: 401 }),
            );

        await expect(adminClient.get('/users')).rejects.toThrow(AdminApiError);
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('should not retry non-401 errors', async () => {
        const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
        );

        await expect(adminClient.get('/users')).rejects.toThrow(AdminApiError);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use the new token in the retry request', async () => {
        const mockFetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ token: 'fresh-token', refreshToken: 'fresh-refresh' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ ok: true }), { status: 200 }),
            );

        await adminClient.get('/users');

        const retryCall = mockFetch.mock.calls[2];
        const retryHeaders = retryCall[1]?.headers as Record<string, string>;
        expect(retryHeaders['Authorization']).toBe('Bearer fresh-token');
    });
});
