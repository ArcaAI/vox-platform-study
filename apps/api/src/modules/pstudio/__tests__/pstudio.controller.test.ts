import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { PrismaStudioController } from '../pstudio.controller';

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
