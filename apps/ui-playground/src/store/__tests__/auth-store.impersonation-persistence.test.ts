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

const ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'];
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

function simulateDoctorContext(state: ReturnType<typeof useAuthStore.getState>) {
    const roles = state.user?.roles ?? [];
    const isAdmin = roles.some((r) => ADMIN_ROLES.includes(r));
    const isDoctor = roles.some((r) => DOCTOR_ROLES.includes(r));
    const isImpersonating = state.isImpersonating;
    const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;
    const effectiveUserId = isImpersonating && state.impersonatedUser
        ? state.impersonatedUser.id
        : state.user?.id ?? '';

    return { effectiveUserId, isImpersonating, requiresImpersonation, isAdmin, isDoctor };
}

describe('Impersonation persistence — simulated page refresh', () => {
    beforeEach(() => {
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    it('should survive a simulated page refresh (store rehydration)', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        expect(state.isImpersonating).toBe(true);
        expect(state.impersonatedUser).toEqual(mockDoctorUser);
        expect(state.impersonationToken).toBe('impersonation-token');
        expect(state.accessToken).toBe('admin-token');
    });

    it('should resolve doctor context correctly after rehydration', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

        useAuthStore.persist.rehydrate();

        const ctx = simulateDoctorContext(useAuthStore.getState());
        expect(ctx.requiresImpersonation).toBe(false);
        expect(ctx.isImpersonating).toBe(true);
        expect(ctx.effectiveUserId).toBe('doctor-001');
    });

    it('should resolve admin as requiring impersonation when NOT impersonating after rehydration', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);

        useAuthStore.persist.rehydrate();

        const ctx = simulateDoctorContext(useAuthStore.getState());
        expect(ctx.requiresImpersonation).toBe(true);
        expect(ctx.isImpersonating).toBe(false);
        expect(ctx.effectiveUserId).toBe('admin-001');
    });

    it('should provide impersonation token for SDK config after rehydration', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        const effectiveToken = state.isImpersonating && state.impersonationToken
            ? state.impersonationToken
            : state.accessToken;
        expect(effectiveToken).toBe('impersonation-token');
    });

    it('should use admin token when not impersonating after rehydration', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);

        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        const effectiveToken = state.isImpersonating && state.impersonationToken
            ? state.impersonationToken
            : state.accessToken;
        expect(effectiveToken).toBe('admin-token');
    });

    it('should clear impersonation state on logout and survive rehydration', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');
        useAuthStore.getState().logout();

        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        expect(state.isImpersonating).toBe(false);
        expect(state.impersonatedUser).toBeNull();
        expect(state.impersonationToken).toBe('');
    });
});
