/**
 * DnaWritingStyleService — DNA playground completeness
 *
 * New playground-facing behaviour:
 *  - generateDnaReport threads `sourceIds` (generate-from-history) into payload
 *  - setDefaultReport promotes a chosen report to the doctor's active/default
 *    (`isLatest`), demoting the previous latest. Tenant + owner scoped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { DnaWritingStyleService } from '../dna-writing-style.service';

const createMockClsService = () => ({ get: vi.fn(), set: vi.fn() });
const createMockEventEmitter = () => ({ emit: vi.fn() });

const createMockDnaReportRepository = () => ({
    findById: vi.fn(),
    findLatestForDoctor: vi.fn(),
    findAllForDoctor: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    $: vi.fn(),
});

const createMockDnaVersionRepository = () => ({ findAll: vi.fn().mockResolvedValue([]), create: vi.fn() });
const createMockDnaUsageRecordRepository = () => ({
    countSince: vi.fn().mockResolvedValue(0),
    getDailyUsageCounts: vi.fn().mockResolvedValue([]),
    findRecent: vi.fn().mockResolvedValue([]),
});
const createMockUserRoleAssignmentRepository = () => ({ findFirst: vi.fn() });
// Membership guard also reads UserDepartment + User.
const createMockUserDepartmentRepository = () => ({ findFirst: vi.fn() });
const createMockUserRepository = () => ({ findFirst: vi.fn() });
const createMockQueue = () => ({ add: vi.fn().mockResolvedValue({ id: 'job-mock' }) });

const createMockReportEntity = (overrides: Record<string, unknown> = {}) => ({
    id: overrides.id ?? 'report-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    doctorId: overrides.doctorId ?? 'user-id-1',
    reportData: overrides.reportData ?? { formality: 'high' },
    styleText: overrides.styleText ?? 'Doctor writes in formal tone.',
    isLatest: overrides.isLatest ?? true,
    currentVersionNumber: 'currentVersionNumber' in overrides ? overrides.currentVersionNumber : 1,
    createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
    createdBy: overrides.createdBy ?? 'user-id-1',
    updatedBy: overrides.updatedBy ?? null,
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
    incrementVersion: vi.fn(),
    markAsLatest: vi.fn(),
    unmarkAsLatest: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    toObject: vi.fn().mockReturnValue(overrides),
});

describe('DnaWritingStyleService — TASK-329 P5', () => {
    let service: DnaWritingStyleService;
    let mockReportRepo: ReturnType<typeof createMockDnaReportRepository>;
    let mockVersionRepo: ReturnType<typeof createMockDnaVersionRepository>;
    let mockUsageRepo: ReturnType<typeof createMockDnaUsageRecordRepository>;
    let mockUserRoleAssignmentRepo: ReturnType<typeof createMockUserRoleAssignmentRepository>;
    let mockUserDepartmentRepo: ReturnType<typeof createMockUserDepartmentRepository>;
    let mockUserRepo: ReturnType<typeof createMockUserRepository>;
    let mockQueue: ReturnType<typeof createMockQueue>;
    let mockClsService: ReturnType<typeof createMockClsService>;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockReportRepo = createMockDnaReportRepository();
        mockVersionRepo = createMockDnaVersionRepository();
        mockUsageRepo = createMockDnaUsageRecordRepository();
        mockUserRoleAssignmentRepo = createMockUserRoleAssignmentRepository();
        mockUserDepartmentRepo = createMockUserDepartmentRepository();
        mockUserRepo = createMockUserRepository();
        mockQueue = createMockQueue();
        mockClsService = createMockClsService();
        mockEventEmitter = createMockEventEmitter();

        mockClsService.get.mockImplementation((key: string) => {
            if (key === 'user') return { id: 'user-id-1' };
            if (key === 'tenantId') return 'tenant-1';
            return null;
        });
        mockUserRoleAssignmentRepo.findFirst.mockResolvedValue({
            id: 'ura-1', userId: 'doctor-id-1', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED,
        });
        // Present in-tenant department so the membership guard passes.
        mockUserDepartmentRepo.findFirst.mockResolvedValue({
            id: 'ud-1', userId: 'doctor-id-1', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED,
        });
        mockUserRepo.findFirst.mockResolvedValue({ id: 'doctor-id-1', isServiceAccount: false });

        service = new DnaWritingStyleService(
            mockReportRepo as never,
            mockVersionRepo as never,
            mockUsageRepo as never,
            mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
            mockQueue as never,
            mockEventEmitter as never,
            mockClsService as never,
        );
    });

    // ─── generate-from-history: sourceIds threading ─────────────

    describe('generateDnaReport — sourceIds (generate-from-history)', () => {
        it('threads sourceIds into the BullMQ job payload', async () => {
            await service.generateDnaReport('doctor-id-1', {
                sourceIds: ['src-1', 'src-2'],
                textSamples: ['sample-a'],
            });

            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.sourceIds).toEqual(['src-1', 'src-2']);
            expect(payload.textSamples).toEqual(['sample-a']);
        });

        it('omits sourceIds from payload when not provided', async () => {
            await service.generateDnaReport('doctor-id-1', {});
            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.sourceIds).toBeUndefined();
        });
    });

    // ─── setDefaultReport ───────────────────────────────────────

    describe('setDefaultReport', () => {
        it('promotes a non-latest report and demotes the previous latest', async () => {
            const target = createMockReportEntity({ id: 'report-old', isLatest: false, doctorId: 'user-id-1' });
            const currentLatest = createMockReportEntity({ id: 'report-new', isLatest: true, doctorId: 'user-id-1' });
            mockReportRepo.findById.mockResolvedValue(target);
            mockReportRepo.findLatestForDoctor.mockResolvedValue(currentLatest);
            mockReportRepo.update.mockResolvedValue(createMockReportEntity({ id: 'report-old', isLatest: true }));

            const result = await service.setDefaultReport('report-old');

            expect(currentLatest.unmarkAsLatest).toHaveBeenCalledTimes(1);
            expect(target.markAsLatest).toHaveBeenCalledTimes(1);
            expect(mockReportRepo.update).toHaveBeenCalledWith('report-new', currentLatest);
            expect(mockReportRepo.update).toHaveBeenCalledWith('report-old', target);
            expect(result.id).toBe('report-old');
            expect(result.isLatest).toBe(true);
        });

        it('broadcasts a ResourceUpdated SysEvent', async () => {
            const target = createMockReportEntity({ id: 'report-old', isLatest: false });
            mockReportRepo.findById.mockResolvedValue(target);
            mockReportRepo.findLatestForDoctor.mockResolvedValue(null);
            mockReportRepo.update.mockResolvedValue(createMockReportEntity({ id: 'report-old', isLatest: true }));

            await service.setDefaultReport('report-old');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceUpdated',
                expect.objectContaining({
                    resourceId: 'report-old',
                    data: expect.objectContaining({ kind: 'dna-default-set' }),
                }),
            );
        });

        it('is idempotent when the report is already the default (no demotion)', async () => {
            const alreadyLatest = createMockReportEntity({ id: 'report-x', isLatest: true });
            mockReportRepo.findById.mockResolvedValue(alreadyLatest);

            const result = await service.setDefaultReport('report-x');

            expect(mockReportRepo.findLatestForDoctor).not.toHaveBeenCalled();
            expect(mockReportRepo.update).not.toHaveBeenCalled();
            expect(result.id).toBe('report-x');
        });

        it('throws NotFoundException when the report does not exist', async () => {
            mockReportRepo.findById.mockResolvedValue(null);
            await expect(service.setDefaultReport('missing')).rejects.toThrow(NotFoundException);
        });

        it('throws NotFoundException for a cross-tenant report (no existence leak)', async () => {
            mockReportRepo.findById.mockResolvedValue(
                createMockReportEntity({ id: 'report-foreign', tenantId: 'tenant-2', isLatest: false }),
            );
            await expect(service.setDefaultReport('report-foreign')).rejects.toThrow(NotFoundException);
            expect(mockReportRepo.update).not.toHaveBeenCalled();
        });

        it("throws ForbiddenException when the caller does not own the report", async () => {
            mockReportRepo.findById.mockResolvedValue(
                createMockReportEntity({ id: 'report-other', doctorId: 'other-doctor', isLatest: false }),
            );
            await expect(service.setDefaultReport('report-other')).rejects.toThrow(ForbiddenException);
            expect(mockReportRepo.update).not.toHaveBeenCalled();
        });
    });
});
