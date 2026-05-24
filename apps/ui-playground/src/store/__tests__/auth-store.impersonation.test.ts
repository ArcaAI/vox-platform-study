import { useAuthStore } from '../auth-store';

const mockAdminUser = {
    id: 'admin-001',
    email: 'admin@test.com',
    username: 'super_admin',
    roles: ['SUPER_ADMIN'],
    permissions: ['*'],
};

const mockDoctorUser = {
    id: 'doctor-001',
    email: 'doctor@test.com',
    username: 'doctor',
    roles: ['DOCTOR'],
    permissions: ['read'],
};

const TENANT_UUID = '50000000-0000-0000-0000-000000000000';

function resetStore() {
    useAuthStore.getState().logout();
}

describe('useAuthStore — impersonation', () => {
    beforeEach(() => {
        localStorage.clear();
        resetStore();
    });

    describe('initial state', () => {
        it('should start with no impersonation', () => {
            const state = useAuthStore.getState();
            expect(state.impersonatedUser).toBeNull();
            expect(state.isImpersonating).toBe(false);
        });
    });

    describe('startImpersonation', () => {
        it('should store the impersonated user', () => {
            useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
            useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

            const state = useAuthStore.getState();
            expect(state.impersonatedUser).toEqual(mockDoctorUser);
            expect(state.isImpersonating).toBe(true);
        });

        it('should store the impersonation token separately from the original token', () => {
            useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
            useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

            const state = useAuthStore.getState();
            expect(state.impersonationToken).toBe('impersonation-token');
            expect(state.accessToken).toBe('admin-token');
        });
    });

    describe('endImpersonation', () => {
        it('should clear impersonation state', () => {
            useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
            useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');
            useAuthStore.getState().endImpersonation();

            const state = useAuthStore.getState();
            expect(state.impersonatedUser).toBeNull();
            expect(state.isImpersonating).toBe(false);
            expect(state.impersonationToken).toBe('');
        });
    });

    describe('logout clears impersonation', () => {
        it('should clear impersonation on logout', () => {
            useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
            useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');
            useAuthStore.getState().logout();

            const state = useAuthStore.getState();
            expect(state.impersonatedUser).toBeNull();
            expect(state.isImpersonating).toBe(false);
            expect(state.impersonationToken).toBe('');
        });
    });

    describe('persistence across refresh (TASK-295 H-1 inverted contract)', () => {
        it('does NOT persist impersonation state — it lives only in tab-scoped memory', () => {
            useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
            useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

            // TASK-295 H-1: impersonation fields are excluded from `partialize`,
            // and storage moved to sessionStorage. localStorage MUST NOT contain
            // the impersonation token.
            expect(localStorage.getItem('arcavox.auth')).toBeNull();
            const stored = JSON.parse(sessionStorage.getItem('arcavox.auth') ?? '{}');
            expect(stored.state?.impersonatedUser).toBeUndefined();
            expect(stored.state?.impersonationToken).toBeUndefined();
        });
    });
});
