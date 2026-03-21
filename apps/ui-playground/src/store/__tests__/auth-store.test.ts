import { useAuthStore } from '../auth-store';

const mockUser = {
    id: 'u-1',
    email: 'test@example.com',
    username: 'tester',
    roles: ['admin'],
    permissions: ['read', 'write'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';
const TENANT_UUID_2 = '50000000-0000-0000-0000-000000000002';

function resetStore() {
    useAuthStore.getState().logout();
}

describe('useAuthStore', () => {
    beforeEach(() => {
        localStorage.clear();
        resetStore();
    });

    describe('initial state', () => {
        it('should start with unauthenticated state', () => {
            expect(useAuthStore.getState().isAuthenticated).toBe(false);
        });

        it('should start with null user', () => {
            expect(useAuthStore.getState().user).toBeNull();
        });

        it('should start with empty apiKey, tenantId, and tenantKey', () => {
            expect(useAuthStore.getState().apiKey).toBe('');
            expect(useAuthStore.getState().tenantId).toBe('');
            expect(useAuthStore.getState().tenantKey).toBe('');
        });
    });

    describe('setApiKeyAuth', () => {
        it('should set authMethod to apiKey', () => {
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            expect(useAuthStore.getState().authMethod).toBe('apiKey');
        });

        it('should set isAuthenticated to true', () => {
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            expect(useAuthStore.getState().isAuthenticated).toBe(true);
        });

        it('should store apiKey and tenantId', () => {
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            expect(useAuthStore.getState().apiKey).toBe('ak-123');
            expect(useAuthStore.getState().tenantId).toBe(TENANT_UUID);
        });

        it('should clear accessToken and user', () => {
            useAuthStore.getState().setCredentialsAuth('token', mockUser, TENANT_UUID);
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID_2);
            expect(useAuthStore.getState().accessToken).toBe('');
            expect(useAuthStore.getState().user).toBeNull();
        });
    });

    describe('setCredentialsAuth', () => {
        it('should set authMethod to credentials', () => {
            useAuthStore.getState().setCredentialsAuth('token-abc', mockUser, TENANT_UUID);
            expect(useAuthStore.getState().authMethod).toBe('credentials');
        });

        it('should set isAuthenticated to true', () => {
            useAuthStore.getState().setCredentialsAuth('token-abc', mockUser, TENANT_UUID);
            expect(useAuthStore.getState().isAuthenticated).toBe(true);
        });

        it('should store token, user, tenantId, and optional tenantKey', () => {
            useAuthStore.getState().setCredentialsAuth('token-abc', mockUser, TENANT_UUID, 'acme-hospital');
            const state = useAuthStore.getState();
            expect(state.accessToken).toBe('token-abc');
            expect(state.user).toEqual(mockUser);
            expect(state.tenantId).toBe(TENANT_UUID);
            expect(state.tenantKey).toBe('acme-hospital');
        });

        it('should default tenantKey to empty when not provided', () => {
            useAuthStore.getState().setCredentialsAuth('token-abc', mockUser, TENANT_UUID);
            expect(useAuthStore.getState().tenantKey).toBe('');
        });

        it('should clear apiKey', () => {
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            useAuthStore.getState().setCredentialsAuth('token-abc', mockUser, TENANT_UUID_2);
            expect(useAuthStore.getState().apiKey).toBe('');
        });
    });

    describe('updateToken', () => {
        it('should update the accessToken', () => {
            useAuthStore.getState().setCredentialsAuth('old-token', mockUser, TENANT_UUID);
            useAuthStore.getState().updateToken('new-token');
            expect(useAuthStore.getState().accessToken).toBe('new-token');
        });
    });

    describe('setTenant', () => {
        it('should update tenantId and tenantName', () => {
            useAuthStore.getState().setTenant(TENANT_UUID, 'Acme Hospital');
            const state = useAuthStore.getState();
            expect(state.tenantId).toBe(TENANT_UUID);
            expect(state.tenantName).toBe('Acme Hospital');
        });

        it('should default tenantName to empty string', () => {
            useAuthStore.getState().setTenant(TENANT_UUID);
            expect(useAuthStore.getState().tenantName).toBe('');
        });
    });

    describe('logout', () => {
        it('should reset all state to initial values', () => {
            useAuthStore.getState().setCredentialsAuth('token', mockUser, TENANT_UUID, 'acme');
            useAuthStore.getState().logout();

            const state = useAuthStore.getState();
            expect(state.authMethod).toBeNull();
            expect(state.apiKey).toBe('');
            expect(state.tenantId).toBe('');
            expect(state.tenantKey).toBe('');
            expect(state.accessToken).toBe('');
            expect(state.user).toBeNull();
        });

        it('should set isAuthenticated to false', () => {
            useAuthStore.getState().setApiKeyAuth('ak', TENANT_UUID);
            useAuthStore.getState().logout();
            expect(useAuthStore.getState().isAuthenticated).toBe(false);
        });
    });

    describe('auth method switching', () => {
        it('switching from apiKey to credentials auth should clear apiKey', () => {
            useAuthStore.getState().setApiKeyAuth('ak-123', TENANT_UUID);
            useAuthStore.getState().setCredentialsAuth('token', mockUser, TENANT_UUID_2);

            const state = useAuthStore.getState();
            expect(state.apiKey).toBe('');
            expect(state.authMethod).toBe('credentials');
        });
    });
});
