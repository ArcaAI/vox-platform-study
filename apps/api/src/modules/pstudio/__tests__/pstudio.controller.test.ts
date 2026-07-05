import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { PrismaStudioController } from '../pstudio.controller';

// -----------------------------------------------------------------------------
// TASK-419 item 4 — the studio surface is production-capable and gated by the
// DEDICATED `manage:PrismaStudio` subject (seeded to the GLOBAL_ADMIN policy
// set) instead of `manage:all`. `manage:all` still passes via the CASL
// wildcard, but the dedicated subject makes studio access delegable.
// -----------------------------------------------------------------------------
describe('PrismaStudioController authorization metadata (TASK-419 item 4)', () => {
    it('is class-gated by manage:PrismaStudio', () => {
        const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PrismaStudioController);
        expect(meta).toEqual([{ action: 'manage', subject: 'PrismaStudio' }]);
    });

    it('serveStudio and handleStudioRequest are method-gated by manage:PrismaStudio', () => {
        for (const handler of [PrismaStudioController.prototype.serveStudio, PrismaStudioController.prototype.handleStudioRequest]) {
            const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
            expect(meta).toEqual([{ action: 'manage', subject: 'PrismaStudio' }]);
        }
    });
});

// -----------------------------------------------------------------------------
// TASK-326 X1 — every raw Prisma Studio query/sequence must be audited.
// The BFF runs arbitrary SQL against the unscoped client (no tenant filter,
// no soft-delete), so the privileged access itself is the auditable event.
// `query` is the read path (READ), `sequence` is the write path (UPDATE).
// -----------------------------------------------------------------------------
const createMockStudioService = () => ({
    executeQuery: vi.fn(),
    executeSequence: vi.fn(),
});

const createMockAuditLogService = () => ({
    recordSystemAction: vi.fn().mockResolvedValue(undefined),
    // unused by the controller but part of the interface surface
    fetchAll: vi.fn(),
    fetchAllByResource: vi.fn(),
    fetchAllCreatedByUser: vi.fn(),
    fetchById: vi.fn(),
    deleteById: vi.fn(),
    handleUserAuthenticatedEvent: vi.fn(),
});

describe('PrismaStudioController (TASK-326 X1 — audit)', () => {
    let studio: ReturnType<typeof createMockStudioService>;
    let audit: ReturnType<typeof createMockAuditLogService>;
    let controller: PrismaStudioController;

    beforeEach(() => {
        vi.clearAllMocks();
        studio = createMockStudioService();
        audit = createMockAuditLogService();
        controller = new PrismaStudioController(studio as never, audit as never);
    });

    it('audits a read `query` as READ before executing it', async () => {
        studio.executeQuery.mockResolvedValue([null, { rows: [] }]);

        const result = await controller.handleStudioRequest({ query: { from: 'User', take: 5 } });

        expect(audit.recordSystemAction).toHaveBeenCalledTimes(1);
        expect(audit.recordSystemAction).toHaveBeenCalledWith(
            expect.objectContaining({
                action: AuditAction.READ,
                eventType: 'PRISMA_STUDIO',
                resourceType: ResourceType.AuditLog,
                data: expect.objectContaining({ kind: 'query' }),
            }),
        );
        expect(studio.executeQuery).toHaveBeenCalledWith({ from: 'User', take: 5 });
        expect(result).toEqual([null, { rows: [] }]);
    });

    it('audits a `sequence` (write path) as UPDATE before executing it', async () => {
        studio.executeSequence.mockResolvedValue([[null, {}], [null, {}]]);
        const sequence = [{ create: 'X' }, { from: 'X' }];

        await controller.handleStudioRequest({ procedure: 'sequence', sequence });

        expect(audit.recordSystemAction).toHaveBeenCalledTimes(1);
        expect(audit.recordSystemAction).toHaveBeenCalledWith(
            expect.objectContaining({
                action: AuditAction.UPDATE,
                eventType: 'PRISMA_STUDIO',
                resourceType: ResourceType.AuditLog,
                data: expect.objectContaining({ kind: 'sequence', procedure: 'sequence' }),
            }),
        );
        expect(studio.executeSequence).toHaveBeenCalledWith(sequence);
    });

    it('records the audit BEFORE delegating to the studio service', async () => {
        const calls: string[] = [];
        audit.recordSystemAction.mockImplementation(async () => {
            calls.push('audit');
        });
        studio.executeQuery.mockImplementation(async () => {
            calls.push('execute');
            return [null, {}];
        });

        await controller.handleStudioRequest({ query: { from: 'User' } });

        expect(calls).toEqual(['audit', 'execute']);
    });

    it('does NOT audit and does NOT execute when neither query nor sequence is present', async () => {
        const result = await controller.handleStudioRequest({});

        expect(audit.recordSystemAction).not.toHaveBeenCalled();
        expect(studio.executeQuery).not.toHaveBeenCalled();
        expect(studio.executeSequence).not.toHaveBeenCalled();
        expect(result).toEqual([{ message: 'Invalid request: missing query or sequence', name: 'BadRequest' }]);
    });
});

// -----------------------------------------------------------------------------
// TASK-336 OB-11 + BUG-003 — the served shell must carry NO credential and no
// client-side credential plumbing at all: auth rides the session cookie through
// the BFF proxy that fronts this route (the proxy injects the bearer
// server-side on GET and POST alike). The body is also no-store so no
// proxy / CDN caches the studio shell.
//
// BUG-003 root cause locked here: the previous shell embedded a Host-derived
// absolute gateway endpoint and expected a `#token=` URL-fragment hand-off.
// Under the admin-console BFF session (httpOnly cookie, token never
// client-readable) no fragment token exists, so the studio's POSTs hit the
// gateway directly with an empty bearer → UnifiedAuthGuard 401. The shell must
// instead post back to the SAME path that served it (window.location.pathname).
// -----------------------------------------------------------------------------
describe('PrismaStudioController.serveStudio (TASK-336 OB-11 + BUG-003)', () => {
    let controller: PrismaStudioController;

    beforeEach(() => {
        controller = new PrismaStudioController(
            createMockStudioService() as never,
            createMockAuditLogService() as never,
        );
    });

    function mockRes() {
        return {
            type: vi.fn().mockReturnThis(),
            send: vi.fn().mockReturnThis(),
            status: vi.fn().mockReturnThis(),
            setHeader: vi.fn(),
        };
    }

    function servedHtml(res = mockRes()): string {
        controller.serveStudio(res as never);
        return (res.send.mock.calls[0]?.[0] ?? '') as string;
    }

    it('serves HTML with no bearer credential or Authorization plumbing (OB-11)', () => {
        const res = mockRes();
        const html = servedHtml(res);

        expect(res.type).toHaveBeenCalledWith('text/html');
        expect(html).not.toContain('Authorization');
        expect(html).not.toContain('Bearer');
    });

    it('marks the studio shell as no-store', () => {
        const res = mockRes();
        servedHtml(res);

        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    it('posts studio queries back to the path that served the shell', () => {
        expect(servedHtml()).toContain('window.location.pathname');
    });

    it('does not embed a Host-derived absolute BFF endpoint', () => {
        expect(servedHtml()).not.toMatch(/createStudioBFFClient\(\{\s*url:\s*['"`]http/);
        expect(servedHtml()).not.toContain('://${host}');
    });

    it('does not rely on a #token URL-fragment contract', () => {
        expect(servedHtml()).not.toContain('#token');
    });
});
