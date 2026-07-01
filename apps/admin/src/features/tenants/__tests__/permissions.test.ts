import { describe, expect, it } from 'vitest';
import {
    canCreateTenant,
    canManageTenantLifecycle,
    canModifyTenant,
    isLifecycleProtectedTenant,
    isSuperAdmin,
    isSystemTenant,
    isTenantAdmin,
} from '../permissions';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

describe('permissions (client-side gate mirroring the server)', () => {
    describe('isSuperAdmin', () => {
        it('is true for SUPER_ADMIN / GLOBAL_ADMIN', () => {
            expect(isSuperAdmin(['SUPER_ADMIN'])).toBe(true);
            expect(isSuperAdmin(['GLOBAL_ADMIN'])).toBe(true);
            expect(isSuperAdmin(['DOCTOR', 'GLOBAL_ADMIN'])).toBe(true);
        });

        it('is false for tenant-scoped or missing roles', () => {
            expect(isSuperAdmin(['TENANT_ADMIN'])).toBe(false);
            expect(isSuperAdmin(['DOCTOR'])).toBe(false);
            expect(isSuperAdmin([])).toBe(false);
            expect(isSuperAdmin(undefined)).toBe(false);
            expect(isSuperAdmin(null)).toBe(false);
        });
    });

    describe('isTenantAdmin', () => {
        it('is true only for TENANT_ADMIN', () => {
            expect(isTenantAdmin(['TENANT_ADMIN'])).toBe(true);
            expect(isTenantAdmin(['SUPER_ADMIN'])).toBe(false);
            expect(isTenantAdmin(undefined)).toBe(false);
        });
    });

    describe('canCreateTenant', () => {
        it('mirrors isSuperAdmin (server @CanManage("Tenant") is super-admin only)', () => {
            expect(canCreateTenant(['SUPER_ADMIN'])).toBe(true);
            expect(canCreateTenant(['TENANT_ADMIN'])).toBe(false);
            expect(canCreateTenant(undefined)).toBe(false);
        });
    });

    describe('isSystemTenant', () => {
        it('detects the system tenant by key (case-insensitive) or isSystem flag', () => {
            expect(isSystemTenant({ key: 'system' })).toBe(true);
            expect(isSystemTenant({ key: 'SYSTEM' })).toBe(true);
            expect(isSystemTenant({ isSystem: true })).toBe(true);
            expect(isSystemTenant({ key: 'acme-health' })).toBe(false);
            expect(isSystemTenant({})).toBe(false);
            expect(isSystemTenant(null)).toBe(false);
        });
    });

    describe('canModifyTenant (system-tenant protection)', () => {
        it('lets a super-admin modify a normal tenant', () => {
            expect(canModifyTenant({ key: 'acme-health' }, ['SUPER_ADMIN'])).toBe(true);
        });

        it('blocks modifying the system tenant even for a super-admin', () => {
            expect(canModifyTenant({ key: 'system' }, ['SUPER_ADMIN'])).toBe(false);
            expect(canModifyTenant({ isSystem: true }, ['GLOBAL_ADMIN'])).toBe(false);
        });

        it('blocks a non-super-admin from modifying any tenant', () => {
            expect(canModifyTenant({ key: 'acme-health' }, ['TENANT_ADMIN'])).toBe(false);
            expect(canModifyTenant({ key: 'acme-health' }, undefined)).toBe(false);
        });
    });

    describe('isLifecycleProtectedTenant (DEF-ADM-002)', () => {
        it('matches the __GLOBAL__ key (case-insensitive), the reserved zero-UUID id, or the isSystem flag', () => {
            expect(isLifecycleProtectedTenant({ key: '__GLOBAL__' })).toBe(true);
            expect(isLifecycleProtectedTenant({ key: '__global__' })).toBe(true);
            expect(isLifecycleProtectedTenant({ id: SYSTEM_TENANT_ID })).toBe(true);
            expect(isLifecycleProtectedTenant({ isSystem: true })).toBe(true);
            // Legacy "system" key stays protected too (parity with isSystemTenant).
            expect(isLifecycleProtectedTenant({ key: 'system' })).toBe(true);
        });

        it('does not protect a normal tenant', () => {
            expect(isLifecycleProtectedTenant({ key: 'acme-health', id: 'abc' })).toBe(false);
            expect(isLifecycleProtectedTenant({})).toBe(false);
            expect(isLifecycleProtectedTenant(null)).toBe(false);
        });
    });

    describe('canManageTenantLifecycle (suspend/archive/restore)', () => {
        it('lets a super-admin manage a normal tenant', () => {
            expect(canManageTenantLifecycle({ key: 'acme-health', id: 'abc' }, ['SUPER_ADMIN'])).toBe(true);
        });

        it('blocks the DEF-ADM-002 system tenant even for a super-admin', () => {
            expect(canManageTenantLifecycle({ key: '__GLOBAL__' }, ['SUPER_ADMIN'])).toBe(false);
            expect(canManageTenantLifecycle({ id: SYSTEM_TENANT_ID }, ['GLOBAL_ADMIN'])).toBe(false);
        });

        it('blocks a non-super-admin from lifecycle actions', () => {
            expect(canManageTenantLifecycle({ key: 'acme-health' }, ['TENANT_ADMIN'])).toBe(false);
            expect(canManageTenantLifecycle({ key: 'acme-health' }, undefined)).toBe(false);
        });
    });
});
