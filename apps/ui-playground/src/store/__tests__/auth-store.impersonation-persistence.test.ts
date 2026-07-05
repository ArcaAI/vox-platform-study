/**
 * TASK-295 H-1 / SEC-A5-4
 *
 * The previous test in this file asserted that an impersonation session
 * survives a page reload (`impersonationToken` rehydrated from localStorage).
 * That is a security defect: a long-lived bearer token for an impersonated
 * subject must NOT survive a tab close / page refresh — only an active,
 * intentional impersonation click should grant elevated access.
 *
 * Under TASK-295 H-1:
 *   - Storage moves from `localStorage` to `sessionStorage`.
 *   - The persisted slice no longer includes `impersonationToken`,
 *     `impersonatedUser`, `isImpersonating`, or `originalTenantId`.
 *   - Page reload during impersonation reverts to the bare admin session.
 *     The user must explicitly re-impersonate.
 *
 * This file inverts the previous assertions accordingly.
 */
import { STORAGE_KEYS } from '@/lib/constants';
import { useAuthStore } from '../auth-store';

const mockAdminUser = {
    id: 'admin-001',
    email: 'admin@test.com',
    username: 'super_admin',
    roles: ['GLOBAL_ADMIN'],
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

describe('Impersonation persistence — TASK-295 H-1 inverted contract', () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
        useAuthStore.getState().logout();
    });

    it('does NOT persist impersonationToken across a simulated reload', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

        const persistedRaw = sessionStorage.getItem(STORAGE_KEYS.AUTH);
        expect(persistedRaw).toBeTruthy();
        const persisted = JSON.parse(persistedRaw as string);
        const state = persisted.state ?? persisted;
        expect(state.impersonationToken).toBeUndefined();
        expect(state.impersonatedUser).toBeUndefined();
        expect(state.isImpersonating).toBeUndefined();
        expect(state.originalTenantId).toBeUndefined();
    });

    it('still persists the bare admin session (accessToken, user, tenant) to sessionStorage', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID, 'tenant-key');

        const raw = sessionStorage.getItem(STORAGE_KEYS.AUTH);
        expect(raw).toBeTruthy();
        const persisted = JSON.parse(raw as string);
        const state = persisted.state ?? persisted;
        expect(state.accessToken).toBe('admin-token');
        expect(state.user).toEqual(mockAdminUser);
        expect(state.tenantId).toBe(TENANT_UUID);
    });

    it('uses sessionStorage rather than localStorage for the auth key', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);

        expect(sessionStorage.getItem(STORAGE_KEYS.AUTH)).toBeTruthy();
        expect(localStorage.getItem(STORAGE_KEYS.AUTH)).toBeNull();
    });

    it('reverts impersonation on a simulated reload — admin must re-impersonate', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');

        // Simulate a reload: drop in-memory state, then rehydrate from storage.
        useAuthStore.setState({
            impersonatedUser: null,
            impersonationToken: '',
            isImpersonating: false,
            originalTenantId: '',
        });
        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        expect(state.isImpersonating).toBe(false);
        expect(state.impersonatedUser).toBeNull();
        expect(state.impersonationToken).toBe('');
        // Admin session itself survives — only the impersonation does not.
        expect(state.accessToken).toBe('admin-token');
        expect(state.user).toEqual(mockAdminUser);
    });

    it('clears impersonation state on logout regardless of storage backend', () => {
        useAuthStore.getState().setCredentialsAuth('admin-token', mockAdminUser, TENANT_UUID);
        useAuthStore.getState().startImpersonation(mockDoctorUser, 'impersonation-token');
        useAuthStore.getState().logout();

        useAuthStore.persist.rehydrate();

        const state = useAuthStore.getState();
        expect(state.isImpersonating).toBe(false);
        expect(state.impersonatedUser).toBeNull();
        expect(state.impersonationToken).toBe('');
        expect(state.accessToken).toBe('');
    });
});
