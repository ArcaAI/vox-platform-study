import { useAuthStore } from '../auth-store';

const mockUser = {
    id: 'u-1',
    email: 'test@example.com',
    username: 'tester',
    roles: ['admin'],
    permissions: ['read', 'write'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

function resetStore() {
    useAuthStore.getState().logout();
}

describe('auth-store — token refresh support (TASK-227)', () => {
    beforeEach(() => {
        localStorage.clear();
        resetStore();
    });

    describe('refreshToken field', () => {
        it('should start with empty refreshToken', () => {
            expect(useAuthStore.getState().refreshToken).toBe('');
        });

        it('should store refreshToken via setCredentialsAuth', () => {
            useAuthStore.getState().setCredentialsAuth(
                'access-token',
                mockUser,
                TENANT_UUID,
                'acme',
                'refresh_u-1_123_abc',
            );
            expect(useAuthStore.getState().refreshToken).toBe('refresh_u-1_123_abc');
        });

        it('should default refreshToken to empty when not provided', () => {
            useAuthStore.getState().setCredentialsAuth('token', mockUser, TENANT_UUID);
            expect(useAuthStore.getState().refreshToken).toBe('');
        });

        it('should clear refreshToken on logout', () => {
            useAuthStore.getState().setCredentialsAuth(
                'token',
                mockUser,
                TENANT_UUID,
                'acme',
                'refresh_u-1_123_abc',
            );
            useAuthStore.getState().logout();
            expect(useAuthStore.getState().refreshToken).toBe('');
        });

        it('should clear refreshToken when switching to apiKey auth', () => {
            useAuthStore.getState().setCredentialsAuth(
                'token',
                mockUser,
                TENANT_UUID,
                'acme',
                'refresh_u-1_123_abc',
            );
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            expect(useAuthStore.getState().refreshToken).toBe('');
        });
    });

    describe('updateTokens', () => {
        it('should update both accessToken and refreshToken', () => {
            useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'old-refresh');
            useAuthStore.getState().updateTokens('new-access', 'new-refresh');
            expect(useAuthStore.getState().accessToken).toBe('new-access');
            expect(useAuthStore.getState().refreshToken).toBe('new-refresh');
        });

        it('should update only accessToken when refreshToken is not provided', () => {
            useAuthStore.getState().setCredentialsAuth('old-access', mockUser, TENANT_UUID, 'acme', 'old-refresh');
            useAuthStore.getState().updateTokens('new-access');
            expect(useAuthStore.getState().accessToken).toBe('new-access');
            expect(useAuthStore.getState().refreshToken).toBe('old-refresh');
        });
    });

    describe('persistence', () => {
        it('should persist refreshToken to localStorage', () => {
            useAuthStore.getState().setCredentialsAuth(
                'token',
                mockUser,
                TENANT_UUID,
                'acme',
                'refresh_u-1_123_abc',
            );
            const stored = JSON.parse(localStorage.getItem('arcavox.auth') || '{}');
            expect(stored.state?.refreshToken).toBe('refresh_u-1_123_abc');
        });
    });
});
