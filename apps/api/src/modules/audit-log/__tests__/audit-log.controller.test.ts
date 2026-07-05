/**
 * TASK-307 W5.7 — AuditLogController tenant scoping (AC-21, audit D-7).
 *
 * Pre-W5.7 `fetchByUser` forwarded the URL's `userId` straight to the
 * service without re-asserting the caller's tenant context. The service
 * already scopes via `buildTenantWhere(...)`, but the audit asks for a
 * defence-in-depth assertion at the controller layer so the rule is
 * visible at the request entry point.
 *
 * Pattern mirrors TASK-305 W1.4: GLOBAL_ADMIN bypasses the tenant scope;
 * every other caller must have a tenantId in CLS.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, StreamableFile } from '@nestjs/common';
import { AuditLogDtoMapper } from '@arcaai/applications';
import { AuditLogController } from '../audit-log.controller';

/** Collect a StreamableFile's bytes into a Buffer (the export handler streams). */
async function readStreamableFile(file: StreamableFile): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function createMockAuditLogService() {
    return {
        fetchAll: vi.fn(),
        fetchAllFiltered: vi
            .fn()
            .mockResolvedValue({ result: { data: [], count: 0, limit: 10, page: 1 }, responsibleUsers: {} }),
        exportFiltered: vi.fn().mockResolvedValue({ rows: [], responsibleUsers: {} }),
        fetchById: vi.fn(),
        fetchAllByResource: vi.fn(),
        fetchAllCreatedByUser: vi.fn().mockResolvedValue({ data: [], count: 0, limit: 10, page: 1 }),
        // TASK-373 — cursor (keyset) page envelope.
        fetchPageByCursor: vi
            .fn()
            .mockResolvedValue({ page: { data: [], nextCursor: null, hasMore: false, limit: 10 }, responsibleUsers: {} }),
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

    it('non-global-admin without a tenant context in CLS is REJECTED with ForbiddenException', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.fetchByUser('any-user-id', {} as never)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(svc.fetchAllCreatedByUser).not.toHaveBeenCalled();
    });

    it('non-global-admin WITH a tenant context is allowed (service-layer buildTenantWhere takes it from here)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByUser('target-user', { page: 1, pageSize: 10 } as never);

        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledTimes(1);
        expect(svc.fetchAllCreatedByUser).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'target-user' }),
        );
    });

    it('GLOBAL_ADMIN without a tenant context is allowed (operator cross-tenant audit reads)', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
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
// entry point and a non-global-admin with no tenant cannot reach the service.
// -----------------------------------------------------------------------------
describe('TASK-326 X5 — AuditLogController.fetchAll tenant scoping', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
    });

    it('rejects a non-global-admin with NO tenant context (ForbiddenException, service untouched)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.fetchAll({} as never)).rejects.toBeInstanceOf(ForbiddenException);
        expect(svc.fetchAllFiltered).not.toHaveBeenCalled();
    });

    it('allows a non-global-admin WITH a tenant context (service-layer buildTenantWhere scopes it)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchAll({ page: 1, pageSize: 10 } as never);

        expect(svc.fetchAllFiltered).toHaveBeenCalledTimes(1);
    });

    it('allows a GLOBAL_ADMIN with no tenant context (operator cross-tenant audit reads)', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchAll({} as never);

        expect(svc.fetchAllFiltered).toHaveBeenCalledTimes(1);
    });
});

// -----------------------------------------------------------------------------
// TASK-328 A8 — AuditLogController filters + CSV export.
// fetchAll must forward the audit filters to the service (which pushes them to
// the repository); the export route must respect the same tenant guard and
// return a text/csv body produced by the DTO mapper.
// -----------------------------------------------------------------------------
describe('TASK-328 A8 — AuditLogController filters honoured', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
    });

    it('forwards from/to/action/resourceType/userId to the filtered service method', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchAll({
            page: 1,
            limit: 20,
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-31T23:59:59.999Z',
            action: 'UPDATE',
            resourceType: 'Consultation',
            userId: 'user-xyz',
        } as never);

        expect(svc.fetchAllFiltered).toHaveBeenCalledWith(
            expect.objectContaining({
                from: '2026-01-01T00:00:00.000Z',
                to: '2026-01-31T23:59:59.999Z',
                action: 'UPDATE',
                resourceType: 'Consultation',
                userId: 'user-xyz',
                sort: 'createdAt:desc',
            }),
        );
    });
});

describe('TASK-328 A8 — AuditLogController.exportCsv', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
    });

    it('rejects a non-global-admin with NO tenant context (service untouched)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.exportCsv({} as never)).rejects.toBeInstanceOf(ForbiddenException);
        expect(svc.exportFiltered).not.toHaveBeenCalled();
    });

    it('returns CSV text (header + one row) for the filtered set', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        svc.exportFiltered.mockResolvedValue({
            rows: [
                {
                    id: 'audit-1',
                    responsibleUserId: 'u1',
                    responsibleIp: '10.0.0.1',
                    resourceType: 'User',
                    resourceId: 'res-1',
                    action: 'CREATE',
                    eventType: 'RESOURCE',
                    success: true,
                    data: { name: 'Test' },
                    createdAt: new Date('2026-02-01T10:00:00.000Z'),
                },
            ],
            responsibleUsers: { u1: { id: 'u1', displayName: 'Alice Nguyen', email: 'alice@example.com' } },
        });

        // TASK-390 #25 — csv is now streamed (StreamableFile) but the bytes are
        // the same TASK-328 CSV; read the stream back to assert content.
        const file = await controller.exportCsv({ action: 'CREATE' } as never);
        expect(file).toBeInstanceOf(StreamableFile);
        expect(file.options.type).toContain('text/csv');
        expect(file.options.disposition).toContain('audit-logs.csv');

        expect(svc.exportFiltered).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE' }));
        const lines = (await readStreamableFile(file)).toString('utf-8').split('\n');
        expect(lines[0]).toContain('id,createdAt,action,resourceType');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('audit-1');
        expect(lines[1]).toContain('Alice Nguyen');
    });

    // TASK-390 #25 (AU2) — xlsx/pdf reuse the same filtered set through the shared
    // table exporter, returning the matching content-type + filename.
    it('streams an .xlsx (spreadsheet content-type, PK zip signature) for format=xlsx', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);
        svc.exportFiltered.mockResolvedValue({
            rows: [{ id: 'audit-1', action: 'CREATE', resourceType: 'User', createdAt: new Date('2026-02-01T10:00:00.000Z') }],
            responsibleUsers: {},
        });

        const file = await controller.exportCsv({ format: 'xlsx' } as never);

        expect(file).toBeInstanceOf(StreamableFile);
        expect(file.options.type).toContain('spreadsheetml');
        expect(file.options.disposition).toContain('audit-logs.xlsx');
        const buf = await readStreamableFile(file);
        expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('streams a .pdf (%PDF header) for format=pdf', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);
        svc.exportFiltered.mockResolvedValue({
            rows: [{ id: 'audit-1', action: 'CREATE', resourceType: 'User', createdAt: new Date('2026-02-01T10:00:00.000Z') }],
            responsibleUsers: {},
        });

        const file = await controller.exportCsv({ format: 'pdf' } as never);

        expect(file.options.type).toBe('application/pdf');
        expect(file.options.disposition).toContain('audit-logs.pdf');
        const buf = await readStreamableFile(file);
        expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    });

    it('allows GLOBAL_ADMIN with no tenant context', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.exportCsv({} as never);
        expect(svc.exportFiltered).toHaveBeenCalledTimes(1);
    });

    // OB-07 (TASK-336) — the controller decides tenant attribution: a global
    // (cross-tenant) export = GLOBAL_ADMIN with no tenant scope → ToCsv must be
    // asked to include the tenant column; a tenant-scoped export must not. The
    // column rendering itself is covered by the applications mapper unit test.
    it('OB-07 — global export (GLOBAL_ADMIN, no tenant scope) requests the tenant column', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);
        const toCsv = vi.spyOn(AuditLogDtoMapper, 'ToCsv').mockReturnValue('');
        svc.exportFiltered.mockResolvedValue({ rows: [], responsibleUsers: {} });

        await controller.exportCsv({} as never);

        expect(toCsv).toHaveBeenCalledWith([], {}, { includeTenant: true });
        toCsv.mockRestore();
    });

    it('OB-07 — tenant-scoped export does not request the tenant column', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);
        const toCsv = vi.spyOn(AuditLogDtoMapper, 'ToCsv').mockReturnValue('');
        svc.exportFiltered.mockResolvedValue({ rows: [], responsibleUsers: {} });

        await controller.exportCsv({} as never);

        expect(toCsv).toHaveBeenCalledWith([], {}, { includeTenant: false });
        toCsv.mockRestore();
    });
});

// -----------------------------------------------------------------------------
// TASK-373 — AuditLogController.fetchByCursor (cursor/keyset pagination).
// The cursor route mirrors the same tenant guard as fetchAll, forwards the
// cursor/limit/filters to the service, and maps the keyset page into the
// nextCursor/hasMore response envelope. The offset routes are untouched.
// -----------------------------------------------------------------------------
describe('TASK-373 — AuditLogController.fetchByCursor (cursor pagination)', () => {
    let svc: ReturnType<typeof createMockAuditLogService>;

    beforeEach(() => {
        svc = createMockAuditLogService();
    });

    it('rejects a non-global-admin with NO tenant context (ForbiddenException, service untouched)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: null, roles: ['DOCTOR'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await expect(controller.fetchByCursor({} as never)).rejects.toBeInstanceOf(ForbiddenException);
        expect(svc.fetchPageByCursor).not.toHaveBeenCalled();
    });

    it('forwards cursor/limit and the A8 filters to fetchPageByCursor', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByCursor({ cursor: 'abc', limit: 25, action: 'UPDATE', userId: 'user-xyz' } as never);

        expect(svc.fetchPageByCursor).toHaveBeenCalledWith(
            expect.objectContaining({ cursor: 'abc', limit: 25, action: 'UPDATE', userId: 'user-xyz' }),
        );
    });

    it('maps the keyset page into the cursor response envelope (nextCursor/hasMore)', async () => {
        const cls = createMockCls({ id: 'u-1', tenantId: 't-OWN', roles: ['DOCTOR'] }, 't-OWN');
        const controller = new AuditLogController(svc as never, cls as never);
        svc.fetchPageByCursor.mockResolvedValue({
            page: { data: [], nextCursor: 'next-token', hasMore: true, limit: 10 },
            responsibleUsers: {},
        });

        const res = await controller.fetchByCursor({ limit: 10 } as never);

        expect(res).toEqual(expect.objectContaining({ nextCursor: 'next-token', hasMore: true, limit: 10, data: [] }));
    });

    it('allows a GLOBAL_ADMIN with no tenant context (operator cross-tenant audit reads)', async () => {
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        await controller.fetchByCursor({} as never);

        expect(svc.fetchPageByCursor).toHaveBeenCalledTimes(1);
    });
});

// -----------------------------------------------------------------------------
// OB-10 (TASK-336) — audit logs are append-only. The admin delete route/handler
// was removed so the trail can never be mutated from the admin surface.
// -----------------------------------------------------------------------------
describe('OB-10 — AuditLogController has no delete capability', () => {
    it('does not expose a delete handler', () => {
        const svc = createMockAuditLogService();
        const cls = createMockCls({ id: 'admin', tenantId: null, roles: ['GLOBAL_ADMIN'] }, null);
        const controller = new AuditLogController(svc as never, cls as never);

        expect((controller as unknown as Record<string, unknown>).delete).toBeUndefined();
    });
});
