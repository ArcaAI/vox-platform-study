/**
 * TASK-307 W5.7 — AuditLogController tenant scoping (AC-21, audit D-7).
 *
 * Pre-W5.7 `fetchByUser` forwarded the URL's `userId` straight to the
 * service without re-asserting the caller's tenant context. The service
 * already scopes via `buildTenantWhere(...)`, but the audit asks for a
 * defence-in-depth assertion at the controller layer so the rule is
 * visible at the request entry point.
 *
 * Pattern mirrors TASK-305 W1.4: SUPER_ADMIN bypasses the tenant scope;
 * every other caller must have a tenantId in CLS.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AuditLogController } from '../audit-log.controller';

function createMockAuditLogService() {
    return {
        fetchAll: vi.fn(),
        fetchById: vi.fn(),
        fetchAllByResource: vi.fn(),
        fetchAllCreatedByUser: vi.fn().mockResolvedValue({ data: [], count: 0, limit: 10, page: 1 }),
        deleteById: vi.fn(),
    };
}

function createMockCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null, tenantId?: string | null) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'user') return user;
            if (key === 'tenantId') return tenantId ?? user?.tenantId ?? undefined;
            return undefined;
        }),
    };
}

describe('TASK-307 W5.7 — AuditLogController.fetchByUser tenant scoping (AC-21, audit D-7)', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
    });

    it('non-super-admin without a tenant context in CLS is REJECTED with ForbiddenException', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.fetchByUser('any-user-id', {} as never)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(svc.fetchAllCreatedByUser).not.toHaveBeenCalled();
    });

    it('non-super-admin WITH a tenant context is allowed (service-layer buildTenantWhere takes it from here)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByUser('target-user', { page: 1, pageSize: 10 } as never);

        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledTimes(1);
        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'target-user' }),
        );
    });

    it('SUPER_ADMIN without a tenant context is allowed (operator cross-tenant audit reads)', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByUser('any-user', {} as never);

        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledTimes(1);
    });

    it('sort default-DESC is preserved (regression guard — surface-only change)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByUser('target-user', {} as never);

        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledWith(
            expect.objectContaining({ sort: 'createdAt:desc' }),
        );
    });
});

// -----------------------------------------------------------------------------
// TASK-326 X5 — AuditLogController.fetchAll tenant scoping.
// The unscoped `fetchAll` list route is the cross-tenant enumeration surface
// (audit X5). The service already scopes via `buildTenantWhere`, but we mirror
// the `fetchByUser` controller guard so the rule is observable at the request
// entry point and a non-super-admin with no tenant cannot reach the service.
// -----------------------------------------------------------------------------
describe('TASK-326 X5 — AuditLogController.fetchAll tenant scoping', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
        svc.fetchAll.mockResolvedValue({ data: [], count: 0, limit: 10, page: 1 });
    });

    it('rejects a non-super-admin with NO tenant context (ForbiddenException, service untouched)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.fetchAll({} as never)).rejects.toBeInstanceOf(ForbiddenException);
        expect(svc.fetchAll).not.toHaveBeenCalled();
    });

    it('allows a non-super-admin WITH a tenant context (service-layer buildTenantWhere scopes it)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchAll({ page: 1, pageSize: 10 } as never);

        expect(svc.fetchAll).toHaveBeenCalledTimes(1);
    });

    it('allows a SUPER_ADMIN with no tenant context (operator cross-tenant audit reads)', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['SUPER_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchAll({} as never);

        expect(svc.fetchAll).toHaveBeenCalledTimes(1);
    });
});
