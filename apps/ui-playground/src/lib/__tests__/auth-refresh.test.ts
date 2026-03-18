import { useAuthStore } from '@/store/auth-store';
import { tryRefreshToken, getTokenExpiryMs, isTokenExpired } from '../auth-refresh';
import { tryRefreshToken, getTokenExpiryMs, isTokenExpired } from '../auth-refresh';

const mockUser = {
    id: 'u-1',
    email: 'test@test.com',
    username: 'tester',
    roles: ['admin'],
    permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

describe('tryRefreshToken', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    it('should return false when no refresh token is stored', async () => {
        useAuthStore.getState().setCredentialsAuth('access', mockUser, TENANT_UUID);
        const result = await tryRefreshToken();
        expect(result).toBe(false);
    });

    it('should return false when authMethod is apiKey', async () => {
        useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
        const result = await tryRefreshToken();
        expect(result).toBe(false);
    });

    it('should call the refresh endpoint and update tokens on success', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(
                JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const result = await tryRefreshToken();

        expect(result).toBe(true);
        expect(useAuthStore.getState().accessToken).toBe('new-access');
        expect(useAuthStore.getState().refreshToken).toBe('new-refresh');
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('/auth/refresh'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ refreshToken: 'refresh_u1_123_abc' }),
            }),
        );
    });

    it('should return false and logout when refresh endpoint returns non-ok', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Invalid refresh token' }), { status: 401 }),
        );

        const result = await tryRefreshToken();

        expect(result).toBe(false);
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('should return false and logout when fetch throws', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

        const result = await tryRefreshToken();

        expect(result).toBe(false);
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('should not call refresh concurrently — second call reuses first', async () => {
        useAuthStore.getState().setCredentialsAuth(
            'old-access',
            mockUser,
            TENANT_UUID,
            'acme',
            'refresh_u1_123_abc',
        );

        let resolveFirst!: (value: Response) => void;
        const fetchPromise = new Promise<Response>((resolve) => {
            resolveFirst = resolve;
        });

        const mockFetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(fetchPromise);

        const call1 = tryRefreshToken();
        const call2 = tryRefreshToken();

        resolveFirst(
            new Response(
                JSON.stringify({ token: 'new-access', refreshToken: 'new-refresh' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const [result1, result2] = await Promise.all([call1, call2]);

        expect(result1).toBe(true);
        expect(result2).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

function createJwt(expInSeconds: number): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const exp = Math.floor(Date.now() / 1000) + expInSeconds;
    const payload = btoa(JSON.stringify({ id: 'u-1', exp }));
    return `${header}.${payload}.fake-sig`;
}

describe('isTokenExpired', () => {
    it('should return true for an expired JWT', () => {
        expect(isTokenExpired(createJwt(-60))).toBe(true);
    });

    it('should return false for a valid (non-expired) JWT', () => {
        expect(isTokenExpired(createJwt(3600))).toBe(false);
    });

    it('should return false for an empty string', () => {
        expect(isTokenExpired('')).toBe(false);
    });

    it('should return false for a malformed token', () => {
        expect(isTokenExpired('not-a-jwt')).toBe(false);
    });

    it('should return false for a JWT without exp claim', () => {
        const header = btoa(JSON.stringify({ alg: 'HS256' }));
        const payload = btoa(JSON.stringify({ id: 'u-1' }));
        expect(isTokenExpired(`${header}.${payload}.sig`)).toBe(false);
    });

    it('should return true for a token that just expired (exp === now)', () => {
        const header = btoa(JSON.stringify({ alg: 'HS256' }));
        const exp = Math.floor(Date.now() / 1000);
        const payload = btoa(JSON.stringify({ id: 'u-1', exp }));
        expect(isTokenExpired(`${header}.${payload}.sig`)).toBe(true);
    });
});

describe('getTokenExpiryMs', () => {
    it('should return positive ms for a valid token', () => {
        const ms = getTokenExpiryMs(createJwt(3600));
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(3600 * 1000);
    });

    it('should return 0 for an expired token', () => {
        expect(getTokenExpiryMs(createJwt(-60))).toBe(0);
    });

    it('should return 0 for a malformed token', () => {
        expect(getTokenExpiryMs('not-a-jwt')).toBe(0);
    });

    it('should return 0 for an empty string', () => {
        expect(getTokenExpiryMs('')).toBe(0);
    });
});
