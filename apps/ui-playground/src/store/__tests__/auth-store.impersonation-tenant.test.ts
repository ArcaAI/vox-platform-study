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

const ADMIN_TENANT = '';
const DOCTOR_TENANT_ID = 'tenant-doctor-aaa-bbb-ccc';

function resetStore() {
    useAuthStore.getState().logout();
}

describe('useAuthStore — impersonation sets tenantId', () => {
    beforeEach(() => {
        localStorage.clear();
        resetStore();
    });

    it('should set tenantId from impersonated user when admin had no tenant', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, ADMIN_TENANT);
        expect(useAuthStore.getState().tenantId).toBe('');

        useAuthStore.getState().startImpersonation(mockDoctorUser, 'imp-token', DOCTOR_TENANT_ID);

        const state = useAuthStore.getState();
        expect(state.tenantId).toBe(DOCTOR_TENANT_ID);
        expect(state.isImpersonating).toBe(true);
        expect(state.impersonatedUser).toEqual(mockDoctorUser);
    });

    it('should override existing tenantId with impersonated user tenantId', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, 'old-tenant');
        expect(useAuthStore.getState().tenantId).toBe('old-tenant');

        useAuthStore.getState().startImpersonation(mockDoctorUser, 'imp-token', DOCTOR_TENANT_ID);

        expect(useAuthStore.getState().tenantId).toBe(DOCTOR_TENANT_ID);
    });

    it('should keep tenantId unchanged when no tenantId passed during impersonation', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, 'existing-tenant');

        useAuthStore.getState().startImpersonation(mockDoctorUser, 'imp-token');

        expect(useAuthStore.getState().tenantId).toBe('existing-tenant');
    });

    it('should restore original tenantId when impersonation ends', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, ADMIN_TENANT);
        const originalTenantId = useAuthStore.getState().tenantId;

        useAuthStore.getState().startImpersonation(mockDoctorUser, 'imp-token', DOCTOR_TENANT_ID);
        expect(useAuthStore.getState().tenantId).toBe(DOCTOR_TENANT_ID);

        useAuthStore.getState().endImpersonation();
        expect(useAuthStore.getState().tenantId).toBe(originalTenantId);
    });

    it('should persist the impersonation tenantId to sessionStorage (TASK-295 H-1)', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, ADMIN_TENANT);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'imp-token', DOCTOR_TENANT_ID);

        // TASK-295 H-1: auth state now persists to sessionStorage, not localStorage.
        const stored = JSON.parse(sessionStorage.getItem('arcavox.auth') ?? '{}');
        expect(stored.state.tenantId).toBe(DOCTOR_TENANT_ID);
    });
});
