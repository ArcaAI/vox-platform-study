/**
 * DnaWritingStyleService Unit Tests
 *
 * Tests for DNA report generation queueing, retrieval with fallback,
 * versioned updates, and admin listing.
 * Mocks only at boundaries: repositories, queue, event emitter.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JobQueue, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { OptimisticConcurrencyException, DataNotFoundException } from '@arcaai/exceptions';
import { DnaWritingStyleService } from '../dna-writing-style.service';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockClsService = () => ({
    get: vi.fn(),
    set: vi.fn(),
});

const createMockEventEmitter = () => ({
    emit: vi.fn(),
});

const createMockQueryBuilder = () => {
    const mockWhere = vi.fn().mockReturnThis();
    const mockToList = vi.fn().mockResolvedValue([]);
    return {
        Where: mockWhere,
        ToList: mockToList,
    };
};

const createMockDnaReportRepository = () => ({
    findById: vi.fn(),
    findLatestForDoctor: vi.fn(),
    findAllForDoctor: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // `updateDnaReport` now writes via Compare-And-Set
    // (`updateWithVersion`). Legacy `.update` stays on the mock for assertions
    // that confirm it is NOT called.
    updateWithVersion: vi.fn(),
    // Repository-level pagination for the admin list.
    findPaginated: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    $: vi.fn(),
});

const createMockDnaVersionRepository = () => ({
    findAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
});

// Usage-record source for the aggregate dashboard.
const createMockDnaUsageRecordRepository = () => ({
    countSince: vi.fn().mockResolvedValue(0),
    getDailyUsageCounts: vi.fn().mockResolvedValue([]),
    findRecent: vi.fn().mockResolvedValue([]),
});

// Required for the `assertUserBelongsToTenant` guard run
// during `generateDnaReport` and `getDnaReport`.
const createMockUserRoleAssignmentRepository = () => ({
    findFirst: vi.fn(),
});

// Membership guard now also reads the UserDepartment join
// table and the User table (service-account exemption).
const createMockUserDepartmentRepository = () => ({
    findFirst: vi.fn(),
});

const createMockUserRepository = () => ({
    findFirst: vi.fn(),
    // Id→username resolution: batch (`findAll`) for the paginated
    // admin list and single (`findById`) for the doctor detail read.
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
});

const createMockQueue = () => ({
    add: vi.fn().mockResolvedValue({ id: 'job-mock' }),
});

// CC-01 — `updateDnaReport` now wraps the version-row insert + the OCC
// compare-and-set in `databaseService.baseClient.$transaction(callback)` so a
// rejected CAS rolls the orphan version row back (mirrors PromptManagementService
// / TenantService). The mock runs the callback with a stub tx client so the body
// executes; tests assert the create + CAS receive that tx client and that a
// thrown conflict propagates without a ResourceUpdated broadcast.
const mockTxClient = { __tx: true } as const;
const createMockDatabaseService = () => ({
    baseClient: {
        $transaction: vi.fn().mockImplementation(
            async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient),
        ),
    },
});

// ─── Entity Helpers ─────────────────────────────────────────────────

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
    unmarkAsLatest: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    toObject: vi.fn().mockReturnValue(overrides),
});

const createMockVersionEntity = (overrides: Record<string, unknown> = {}) => ({
    id: overrides.id ?? 'version-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    dnaReportId: overrides.dnaReportId ?? 'report-id-1',
    versionNumber: overrides.versionNumber ?? 1,
    reportData: overrides.reportData ?? { formality: 'high' },
    styleText: overrides.styleText ?? 'Doctor writes in formal tone.',
    changeReason: overrides.changeReason ?? 'Initial analysis',
    changedBy: overrides.changedBy ?? 'user-id-1',
    createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
});

// Mock domain factories
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        DnaWritingStyleVersionFactory: {
            CreateDnaWritingStyleVersion: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-version-id',
                createdAt: new Date('2026-02-18T10:00:00Z'),
            })),
        },
    };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('DnaWritingStyleService', () => {
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
    let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;

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
        mockDatabaseService = createMockDatabaseService();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'user-id-1' };
                case 'tenantId':
                    return 'tenant-1';
                default:
                    return null;
            }
        });

        // Default to a permissive in-tenant assignment so
        // legacy tests (which don't care about the new doctor-membership
        // guard) keep passing.
        mockUserRoleAssignmentRepo.findFirst.mockResolvedValue({
            id: 'ura-doctor-1',
            userId: 'doctor-id-1',
            tenantId: 'tenant-1',
            resourceStatus: ResourceStatusType.ENABLED,
        });
        // Default to a present in-tenant department so the
        // role+department membership guard passes for the happy path.
        mockUserDepartmentRepo.findFirst.mockResolvedValue({
            id: 'ud-doctor-1',
            userId: 'doctor-id-1',
            tenantId: 'tenant-1',
            resourceStatus: ResourceStatusType.ENABLED,
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
            mockDatabaseService as never,
        );
    });

    // ─── generateDnaReport ──────────────────────────────────────

    describe('generateDnaReport', () => {
        it('should queue a BullMQ job and return PENDING status', async () => {
            const result = await service.generateDnaReport('doctor-id-1', {});

            expect(result.jobId).toBeDefined();
            expect(result.status).toBe('PENDING');
            expect(mockQueue.add).toHaveBeenCalledTimes(1);
        });

        it('audits the generation REQUEST via a ResourceCreated SysEvent', async () => {
            await service.generateDnaReport('doctor-id-1', {});

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceCreated',
                expect.objectContaining({
                    resourceId: 'doctor-id-1',
                    data: expect.objectContaining({ kind: 'dna-generation-requested', doctorId: 'doctor-id-1' }),
                }),
            );
        });

        it('should include doctorId, tenantId, userId in job payload', async () => {
            await service.generateDnaReport('doctor-id-1', {
                textSamples: ['sample1'],
            });

            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.doctorId).toBe('doctor-id-1');
            expect(payload.tenantId).toBe('tenant-1');
            expect(payload.userId).toBe('user-id-1');
            expect(payload.textSamples).toEqual(['sample1']);
            expect(payload).not.toHaveProperty('departmentId');
        });

        it('should generate unique jobId for each call', async () => {
            const result1 = await service.generateDnaReport('doctor-id-1', {});
            const result2 = await service.generateDnaReport('doctor-id-1', {});

            expect(result1.jobId).not.toBe(result2.jobId);
        });

        it('should succeed with textSamples', async () => {
            const result = await service.generateDnaReport('doctor-id-1', {
                textSamples: ['Sample 1', 'Sample 2'],
            });

            expect(result.status).toBe('PENDING');
            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.textSamples).toEqual(['Sample 1', 'Sample 2']);
        });

        it('should succeed without textSamples (will be gathered by processor)', async () => {
            const result = await service.generateDnaReport('doctor-id-1', {});

            expect(result.status).toBe('PENDING');
            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.textSamples).toBeUndefined();
        });

        it('should call Queue.add with correct queue name and jobId option', async () => {
            const result = await service.generateDnaReport('doctor-id-1', {});

            expect(mockQueue.add).toHaveBeenCalledWith(
                JobQueue.GenerateDnaReport,
                expect.objectContaining({
                    jobId: result.jobId,
                    doctorId: 'doctor-id-1',
                    tenantId: 'tenant-1',
                    userId: 'user-id-1',
                }),
                { jobId: result.jobId },
            );
        });

        it('should include tenantId and userId from ClsService in payload', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'custom-user-99' };
                if (key === 'tenantId') return 'custom-tenant-42';
                return null;
            });

            const freshService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            await freshService.generateDnaReport('doctor-id-1', {});

            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.tenantId).toBe('custom-tenant-42');
            expect(payload.userId).toBe('custom-user-99');
        });
    });

    // ─── getDnaReport ───────────────────────────────────────────

    describe('getDnaReport', () => {
        it('should return latest report for doctor', async () => {
            mockReportRepo.findLatestForDoctor.mockResolvedValue(
                createMockReportEntity({ doctorId: 'doctor-id-1' }),
            );

            const result = await service.getDnaReport('doctor-id-1');

            expect(result).not.toBeNull();
            expect(result!.doctorId).toBe('doctor-id-1');
            expect(result!.isLatest).toBe(true);
        });

        it('should return null when no report exists', async () => {
            mockReportRepo.findLatestForDoctor.mockResolvedValue(null);

            const result = await service.getDnaReport('doctor-no-report');

            expect(result).toBeNull();
        });

        // Human-readable label resolution for the detail read.
        it('resolves doctorUsername when the user exists', async () => {
            mockReportRepo.findLatestForDoctor.mockResolvedValue(
                createMockReportEntity({ doctorId: 'doctor-id-1' }),
            );
            mockUserRepo.findById.mockResolvedValue({ id: 'doctor-id-1', username: 'dr.house' });

            const result = await service.getDnaReport('doctor-id-1');

            expect(mockUserRepo.findById).toHaveBeenCalledWith('doctor-id-1');
            expect(result!.doctorUsername).toBe('dr.house');
        });

        it('leaves doctorUsername undefined when the user lookup throws (deleted/missing)', async () => {
            mockReportRepo.findLatestForDoctor.mockResolvedValue(
                createMockReportEntity({ doctorId: 'doctor-id-1' }),
            );
            mockUserRepo.findById.mockRejectedValue(
                new DataNotFoundException('User', 'doctor-id-1'),
            );

            const result = await service.getDnaReport('doctor-id-1');

            expect(result!.doctorUsername).toBeUndefined();
        });
    });

    // ─── getDnaReport (no department fallback) ────────────────

    describe('getDnaReport (no department fallback)', () => {
        it('should return null when doctor has no report — no department fallback', async () => {
            mockReportRepo.findLatestForDoctor.mockResolvedValue(null);

            const result = await service.getDnaReport('doctor-no-report');

            expect(result).toBeNull();
        });

        it('should not have getDnaReportWithFallback method', () => {
            expect((service as any).getDnaReportWithFallback).toBeUndefined();
        });
    });

    // ─── updateDnaReport ────────────────────────────────────────

    describe('updateDnaReport', () => {
        // ─── optimistic concurrency control ──────────
        // The final persistence write is a Compare-And-Set against the row's
        // `_version` OCC token (DISTINCT from `currentVersionNumber` / the
        // DnaVersion history). The admin PATCH route folds the `If-Match`
        // header onto `dto.expectedVersion`, which is the CAS predicate input.
        it('writes via Compare-And-Set (updateWithVersion) carrying the DTO expectedVersion', async () => {
            const existing = createMockReportEntity({ currentVersionNumber: 1 });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ currentVersionNumber: 2, styleText: 'Updated' }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));

            await service.updateDnaReport('report-id-1', {
                styleText: 'Updated style',
                changeReason: 'Refined analysis',
                expectedVersion: 7,
            });

            expect(mockReportRepo.updateWithVersion).toHaveBeenCalledWith('report-id-1', existing, 7, mockTxClient);
            // CAS-only — the legacy non-versioned write MUST NOT fire.
            expect(mockReportRepo.update).not.toHaveBeenCalled();
        });

        it('propagates OptimisticConcurrencyException from the repository CAS write', async () => {
            // On version drift the repository CAS predicate matches 0 rows and
            // throws; the service must surface it unwrapped so the API layer
            // maps it to 412 Precondition Failed. No ResourceUpdated SysEvent
            // may fire for a write that never landed.
            const existing = createMockReportEntity({ currentVersionNumber: 1 });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));
            mockReportRepo.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('DnaWritingStyleReport', 'report-id-1', {
                    expectedVersion: 7,
                    currentVersion: 8,
                }),
            );

            await expect(
                service.updateDnaReport('report-id-1', { styleText: 'Stale write', expectedVersion: 7 }),
            ).rejects.toThrow(OptimisticConcurrencyException);

            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                'SysEvent.ResourceUpdated',
                expect.anything(),
            );
        });

        // ─── CC-01 — non-transactional OCC write (orphan version row) ────────
        // Before the fix the version-history insert and the OCC compare-and-set
        // were two independent awaits: a stale `If-Match` (412) rejected the CAS
        // yet the version row had already committed — a live-reproduced orphan.
        // The two writes must now share ONE `$transaction` so a rejected CAS
        // rolls the version row back.
        it('runs the version-history insert and the CAS write inside a single transaction', async () => {
            const existing = createMockReportEntity({ currentVersionNumber: 1 });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ currentVersionNumber: 2, styleText: 'Updated' }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));

            await service.updateDnaReport('report-id-1', {
                styleText: 'Updated style',
                changeReason: 'Refined analysis',
                expectedVersion: 7,
            });

            // one interactive transaction wraps the whole versioned write…
            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
            // …and BOTH the insert and the CAS receive the tx client so they
            // commit / roll back atomically.
            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ versionNumber: 2 }),
                mockTxClient,
            );
            expect(mockReportRepo.updateWithVersion).toHaveBeenCalledWith('report-id-1', existing, 7, mockTxClient);
        });

        it('rolls back the version-history insert when the OCC CAS is rejected — no orphan, no event', async () => {
            const existing = createMockReportEntity({ currentVersionNumber: 1 });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));
            // On version drift the repository CAS predicate matches 0 rows and
            // throws from INSIDE the transaction callback, aborting the tx.
            mockReportRepo.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('DnaWritingStyleReport', 'report-id-1', {
                    expectedVersion: 7,
                    currentVersion: 8,
                }),
            );

            await expect(
                service.updateDnaReport('report-id-1', { styleText: 'Stale write', expectedVersion: 7 }),
            ).rejects.toThrow(OptimisticConcurrencyException);

            // the insert + CAS ran inside the SAME transaction, so the throw
            // aborts it and the version row never commits (no orphan persists).
            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ versionNumber: 2 }),
                mockTxClient,
            );
            expect(mockReportRepo.updateWithVersion).toHaveBeenCalledWith('report-id-1', existing, 7, mockTxClient);
            // a write that never landed must not broadcast.
            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('SysEvent.ResourceUpdated', expect.anything());
        });

        it('should create version snapshot and increment version', async () => {
            const existing = createMockReportEntity({ currentVersionNumber: 1 });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ currentVersionNumber: 2, styleText: 'Updated' }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));

            const result = await service.updateDnaReport('report-id-1', {
                styleText: 'Updated style',
                changeReason: 'Refined analysis',
            });

            expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
            expect(result.currentVersionNumber).toBe(2);
        });

        it('should throw NotFoundException when report not found', async () => {
            mockReportRepo.findById.mockResolvedValue(null);

            await expect(
                service.updateDnaReport('nonexistent', { styleText: 'x' }),
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when caller does not own the report', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);

            await expect(
                service.updateDnaReport('report-other', { styleText: 'hijack' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should include descriptive message in ForbiddenException', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);

            await expect(
                service.updateDnaReport('report-other', { styleText: 'hijack' }),
            ).rejects.toThrow("Cannot update another doctor's DNA report");
        });

        it('should throw ForbiddenException when userId is null and report has a doctorId', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                if (key === 'tenantId') return 'tenant-1';
                return null;
            });

            const freshService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            const report = createMockReportEntity({ doctorId: 'some-doctor' });
            mockReportRepo.findById.mockResolvedValue(report);

            await expect(
                freshService.updateDnaReport('report-id-1', { styleText: 'x' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should allow update when caller owns the report', async () => {
            const ownReport = createMockReportEntity({
                id: 'report-mine',
                doctorId: 'user-id-1',
            });
            mockReportRepo.findById.mockResolvedValue(ownReport);
            mockReportRepo.updateWithVersion.mockResolvedValue(ownReport);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.updateDnaReport('report-mine', { styleText: 'Updated' });

            expect(result).toBeDefined();
            expect(result.doctorId).toBe('user-id-1');
        });

        it('should allow admin to update any report when bypassOwnershipCheck is true', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);
            mockReportRepo.updateWithVersion.mockResolvedValue(otherDoctorReport);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.updateDnaReport(
                'report-other',
                { styleText: 'Admin update' },
                { bypassOwnershipCheck: true },
            );

            expect(result).toBeDefined();
            expect(result.doctorId).toBe('other-doctor-id');
        });

        it('should still enforce ownership when bypassOwnershipCheck is false', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);

            await expect(
                service.updateDnaReport('report-other', { styleText: 'x' }, { bypassOwnershipCheck: false }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should still enforce ownership when options is undefined', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);

            await expect(
                service.updateDnaReport('report-other', { styleText: 'x' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should not modify report fields when dto has no updates', async () => {
            const existing = createMockReportEntity({
                reportData: { formality: 'high' },
                styleText: 'Original style',
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updateDnaReport('report-id-1', {});

            expect(existing.reportData).toEqual({ formality: 'high' });
            expect(existing.styleText).toBe('Original style');
        });

        it('should succeed with both reportData and styleText', async () => {
            const existing = createMockReportEntity({
                reportData: { formality: 'high' },
                styleText: 'Original',
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({
                    reportData: { formality: 'low', tone: 'casual' },
                    styleText: 'Updated style',
                    currentVersionNumber: 2,
                }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.updateDnaReport('report-id-1', {
                reportData: { formality: 'low', tone: 'casual' },
                styleText: 'Updated style',
            });

            expect(existing.reportData).toEqual({ formality: 'low', tone: 'casual' });
            expect(existing.styleText).toBe('Updated style');
            expect(result.currentVersionNumber).toBe(2);
        });

        it('should succeed with only styleText (partial update)', async () => {
            const existing = createMockReportEntity({
                reportData: { formality: 'high' },
                styleText: 'Original style',
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updateDnaReport('report-id-1', { styleText: 'New style' });

            expect(existing.styleText).toBe('New style');
            expect(existing.reportData).toEqual({ formality: 'high' });
        });

        it('should succeed with only reportData (partial update)', async () => {
            const existing = createMockReportEntity({
                reportData: { formality: 'high' },
                styleText: 'Original style',
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updateDnaReport('report-id-1', {
                reportData: { formality: 'low', sentenceLength: 'short' },
            });

            expect(existing.reportData).toEqual({ formality: 'low', sentenceLength: 'short' });
            expect(existing.styleText).toBe('Original style');
        });

        it('should increment version from null to 1', async () => {
            const existing = createMockReportEntity({ currentVersionNumber: null });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ currentVersionNumber: 1 }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 1 }));

            await service.updateDnaReport('report-id-1', { styleText: 'Updated' });

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ versionNumber: 1 }),
                mockTxClient,
            );
        });

        it('should broadcast ResourceUpdated event', async () => {
            mockReportRepo.findById.mockResolvedValue(createMockReportEntity());
            mockReportRepo.updateWithVersion.mockResolvedValue(createMockReportEntity());
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updateDnaReport('report-id-1', {
                styleText: 'Updated',
                changeReason: 'Manual edit',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceUpdated',
                expect.objectContaining({
                    resourceId: 'report-id-1',
                    data: { changeReason: 'Manual edit' },
                }),
            );
        });

        it('should toggle resourceStatus to DISABLED without creating a new version', async () => {
            const existing = createMockReportEntity({
                id: 'report-toggle',
                doctorId: 'user-id-1',
                resourceStatus: 'ENABLED',
                currentVersionNumber: 3,
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ ...existing, resourceStatus: 'DISABLED' }),
            );

            const result = await service.updateDnaReport('report-toggle', {
                resourceStatus: 'DISABLED',
            });

            expect(mockVersionRepo.create).not.toHaveBeenCalled();
            expect(existing.incrementVersion).not.toHaveBeenCalled();
            expect(result).toBeDefined();
        });

        it('should toggle resourceStatus to ENABLED without creating a new version', async () => {
            const existing = createMockReportEntity({
                id: 'report-toggle',
                doctorId: 'user-id-1',
                resourceStatus: 'DISABLED',
                currentVersionNumber: 2,
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ ...existing, resourceStatus: 'ENABLED' }),
            );

            const result = await service.updateDnaReport('report-toggle', {
                resourceStatus: 'ENABLED',
            });

            expect(mockVersionRepo.create).not.toHaveBeenCalled();
            expect(existing.incrementVersion).not.toHaveBeenCalled();
            expect(result).toBeDefined();
        });

        it('should create a new version when content changes alongside resourceStatus toggle', async () => {
            const existing = createMockReportEntity({
                id: 'report-both',
                doctorId: 'user-id-1',
                currentVersionNumber: 1,
            });
            mockReportRepo.findById.mockResolvedValue(existing);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ currentVersionNumber: 2, resourceStatus: 'DISABLED' }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));

            const result = await service.updateDnaReport('report-both', {
                styleText: 'New style',
                resourceStatus: 'DISABLED',
            });

            expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
            expect(result.currentVersionNumber).toBe(2);
        });

        it('should allow admin to toggle resourceStatus on another doctor report with bypassOwnershipCheck', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
                resourceStatus: 'ENABLED',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);
            mockReportRepo.updateWithVersion.mockResolvedValue(
                createMockReportEntity({ ...otherDoctorReport, resourceStatus: 'DISABLED' }),
            );

            const result = await service.updateDnaReport(
                'report-other',
                { resourceStatus: 'DISABLED' },
                { bypassOwnershipCheck: true },
            );

            expect(result).toBeDefined();
            expect(mockVersionRepo.create).not.toHaveBeenCalled();
        });

        it('should reject resourceStatus toggle on another doctor report without bypassOwnershipCheck', async () => {
            const otherDoctorReport = createMockReportEntity({
                id: 'report-other',
                doctorId: 'other-doctor-id',
                resourceStatus: 'ENABLED',
            });
            mockReportRepo.findById.mockResolvedValue(otherDoctorReport);

            await expect(
                service.updateDnaReport('report-other', { resourceStatus: 'DISABLED' }),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    // ─── getVersions ────────────────────────────────────────────

    describe('getVersions', () => {
        // `getVersions` now loads the parent report first to
        // enforce the tenant scope, so each test must seed `findById` with a
        // report in the caller's tenant.
        beforeEach(() => {
            mockReportRepo.findById.mockResolvedValue(
                createMockReportEntity({ id: 'report-id-1', tenantId: 'tenant-1' }),
            );
        });

        it('should return all versions for a report sorted by version desc', async () => {
            mockVersionRepo.findAll.mockResolvedValue([
                createMockVersionEntity({ versionNumber: 2 }),
                createMockVersionEntity({ versionNumber: 1 }),
            ]);

            const result = await service.getVersions('report-id-1');

            expect(result).toHaveLength(2);
            expect(result[0].versionNumber).toBe(2);
        });

        it('should return empty array when no versions exist', async () => {
            mockVersionRepo.findAll.mockResolvedValue([]);

            const result = await service.getVersions('report-id-1');

            expect(result).toEqual([]);
        });

        it('should pass correct filters to repository', async () => {
            mockVersionRepo.findAll.mockResolvedValue([]);

            await service.getVersions('report-id-1');

            expect(mockVersionRepo.findAll).toHaveBeenCalledWith({
                filters: { dnaReportId: 'report-id-1' },
                sort: [{ versionNumber: 'desc' }],
            });
        });
    });

    // ─── listReports ────────────────────────────────────────────

    describe('listReports', () => {
        it('should return all reports for current tenant when no filters', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1' }),
                createMockReportEntity({ id: 'r2' }),
            ]);

            const result = await service.listReports();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(result).toHaveLength(2);
        });

        it('should filter by doctorId alongside tenantId when provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([createMockReportEntity()]);

            const result = await service.listReports({ doctorId: 'user-id-1' });

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ doctorId: 'user-id-1' });
            expect(result).toHaveLength(1);
        });

        it('should return empty array when no reports exist', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            const result = await service.listReports();

            expect(result).toEqual([]);
        });

        it('should filter by resourceStatus ENABLED by default when includeDisabled is not set', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listReports();

            expect(mockQb.Where).toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
        });

        it('should not filter by resourceStatus when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', resourceStatus: 'ENABLED' }),
                createMockReportEntity({ id: 'r2', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listReports({ includeDisabled: true });

            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(result).toHaveLength(2);
        });

        it('should filter by resourceStatus ENABLED when includeDisabled is explicitly false', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listReports({ includeDisabled: false });

            expect(mockQb.Where).toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
        });

        it('should return mixed ENABLED and DISABLED reports when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', resourceStatus: 'ENABLED' }),
                createMockReportEntity({ id: 'r2', resourceStatus: 'DISABLED' }),
                createMockReportEntity({ id: 'r3', resourceStatus: 'ENABLED' }),
            ]);

            const result = await service.listReports({ includeDisabled: true });

            expect(result).toHaveLength(3);
            const statuses = result.map(r => r.resourceStatus);
            expect(statuses).toContain('ENABLED');
            expect(statuses).toContain('DISABLED');
        });

        it('should not filter out all-DISABLED results when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', resourceStatus: 'DISABLED' }),
                createMockReportEntity({ id: 'r2', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listReports({ includeDisabled: true });

            expect(result).toHaveLength(2);
            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
        });

        it('should include resourceStatus in response DTOs from listReports', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listReports({ includeDisabled: true });

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveProperty('resourceStatus');
            expect(result[0].resourceStatus).toBe('DISABLED');
        });

        it('should combine includeDisabled with doctorId filter', async () => {
            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', doctorId: 'doc-1', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listReports({ doctorId: 'doc-1', includeDisabled: true });

            expect(mockQb.Where).toHaveBeenCalledWith({ doctorId: 'doc-1' });
            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
            expect(result).toHaveLength(1);
        });

        it('should throw BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((key: string) =>
                key === 'tenantId' ? null : { id: 'user-id-1' },
            );

            const freshService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            await expect(freshService.listReports()).rejects.toThrow(BadRequestException);
        });

        it('should include descriptive message in BadRequestException', async () => {
            mockClsService.get.mockImplementation((key: string) =>
                key === 'tenantId' ? null : { id: 'user-id-1' },
            );

            const freshService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            await expect(freshService.listReports()).rejects.toThrow('Tenant ID is required');
        });

        // The retired SUPER_ADMIN role string grants NO elevation:
        // such a caller is treated like any non-admin (tenant context required).
        it('does NOT treat the retired SUPER_ADMIN role as elevated', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'super-admin-1', roles: ['SUPER_ADMIN'] };
                if (key === 'tenantId') return null;
                return null;
            });

            const retiredRoleService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            await expect(retiredRoleService.listReports()).rejects.toThrow('Tenant ID is required');
        });

        it('should return all reports across tenants when user is GLOBAL_ADMIN without tenantId', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'global-admin-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return null;
                return null;
            });

            const globalAdminService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockReportEntity({ id: 'r1', tenantId: 'tenant-X' }),
            ]);

            const result = await globalAdminService.listReports();

            expect(mockQb.Where).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }));
            expect(result).toHaveLength(1);
        });

        it('should still scope by tenantId when GLOBAL_ADMIN has a tenantId set', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'global-admin-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return 'tenant-scoped';
                return null;
            });

            const scopedSuperAdmin = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([createMockReportEntity()]);

            await scopedSuperAdmin.listReports();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-scoped' });
        });

        it('should throw BadRequestException when non-admin user has no tenantId', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'doctor-1', roles: ['DOCTOR'] };
                if (key === 'tenantId') return null;
                return null;
            });

            const doctorService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            await expect(doctorService.listReports()).rejects.toThrow(BadRequestException);
        });

        it('should scope TENANT_ADMIN by their tenantId', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'tenant-admin-1', roles: ['TENANT_ADMIN'] };
                if (key === 'tenantId') return 'tenant-admin-tenant';
                return null;
            });

            const tenantAdminService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([createMockReportEntity()]);

            await tenantAdminService.listReports();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-admin-tenant' });
        });
    });

    // ─── listReportsPaginated ───────────────

    describe('listReportsPaginated', () => {
        const buildWith = (clsImpl: (key: string) => unknown) => {
            mockClsService.get.mockImplementation(clsImpl);
            return new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );
        };

        it('delegates to repository.findPaginated and returns {data,count,page,limit}', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({
                data: [createMockReportEntity({ id: 'r1' }), createMockReportEntity({ id: 'r2' })],
                count: 7,
            });

            const result = await service.listReportsPaginated({ page: 2, limit: 2 });

            expect(mockReportRepo.findPaginated).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }),
                2,
                2,
            );
            expect(result.count).toBe(7);
            expect(result.page).toBe(2);
            expect(result.limit).toBe(2);
            expect(result.data).toHaveLength(2);
        });

        it('defaults to page 1 / limit 50 and folds doctorId into the where clause', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await service.listReportsPaginated({ doctorId: 'doc-9' });

            const [where, page, limit] = mockReportRepo.findPaginated.mock.calls[0];
            expect(page).toBe(1);
            expect(limit).toBe(50);
            expect(where).toMatchObject({ tenantId: 'tenant-1', doctorId: 'doc-9', resourceStatus: ResourceStatusType.ENABLED });
        });

        it('drops the ENABLED-only constraint when includeDisabled is true', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await service.listReportsPaginated({ includeDisabled: true });

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).not.toHaveProperty('resourceStatus');
            expect(where).toMatchObject({ tenantId: 'tenant-1' });
        });

        it('scopes a TENANT_ADMIN to their CLS tenant and ignores a requested tenantId override', async () => {
            const tenantAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'tenant-admin-1', roles: ['TENANT_ADMIN'] };
                if (key === 'tenantId') return 'tenant-1';
                return null;
            });
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await tenantAdmin.listReportsPaginated({ tenantId: 'tenant-OTHER' });

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).toMatchObject({ tenantId: 'tenant-1' });
        });

        it('uses the requested tenantId for a global admin', async () => {
            const globalAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return null;
                return null;
            });
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await globalAdmin.listReportsPaginated({ tenantId: 'tenant-X' });

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).toMatchObject({ tenantId: 'tenant-X' });
        });

        it('omits the tenantId filter for a global admin with no tenantId (all tenants)', async () => {
            const globalAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return null;
                return null;
            });
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await globalAdmin.listReportsPaginated();

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).not.toHaveProperty('tenantId');
        });

        // CC-02 — a super-admin who has selected an active tenant
        // (X-Tenant-Id → CLS `tenantId`) but omits the `?tenantId` query param
        // must see ONLY that tenant's reports, not every tenant's.
        it('scopes a global admin with an active tenant header and no explicit tenantId to the active tenant', async () => {
            const globalAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return 'tenant-ACTIVE';
                return null;
            });
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await globalAdmin.listReportsPaginated();

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).toMatchObject({ tenantId: 'tenant-ACTIVE' });
        });

        it('an explicit tenantId still overrides the active tenant header for a global admin', async () => {
            const globalAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
                if (key === 'tenantId') return 'tenant-ACTIVE';
                return null;
            });
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await globalAdmin.listReportsPaginated({ tenantId: 'tenant-X' });

            const [where] = mockReportRepo.findPaginated.mock.calls[0];
            expect(where).toMatchObject({ tenantId: 'tenant-X' });
        });

        it('throws BadRequestException when a TENANT_ADMIN has no CLS tenant', async () => {
            const tenantAdmin = buildWith((key: string) => {
                if (key === 'user') return { id: 'tenant-admin-1', roles: ['TENANT_ADMIN'] };
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(tenantAdmin.listReportsPaginated()).rejects.toThrow(BadRequestException);
        });

        // Human-readable label resolution for the admin list.
        it('resolves doctorUsername for rows whose doctor exists and leaves it undefined otherwise', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({
                data: [
                    createMockReportEntity({ id: 'r1', doctorId: 'doc-1' }),
                    createMockReportEntity({ id: 'r2', doctorId: 'doc-2' }),
                ],
                count: 2,
            });
            // Only doc-1 resolves; doc-2 is missing (e.g. deleted) → undefined.
            mockUserRepo.findAll.mockResolvedValue([{ id: 'doc-1', username: 'dr.strange' }]);

            const result = await service.listReportsPaginated({ page: 1, limit: 2 });

            expect(result.data[0].doctorUsername).toBe('dr.strange');
            expect(result.data[1].doctorUsername).toBeUndefined();
        });

        it('issues at most ONE user query per call and dedupes doctor ids', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({
                data: [
                    createMockReportEntity({ id: 'r1', doctorId: 'doc-1' }),
                    createMockReportEntity({ id: 'r2', doctorId: 'doc-1' }),
                    createMockReportEntity({ id: 'r3', doctorId: 'doc-2' }),
                ],
                count: 3,
            });
            mockUserRepo.findAll.mockResolvedValue([
                { id: 'doc-1', username: 'dr.who' },
                { id: 'doc-2', username: 'dr.no' },
            ]);

            await service.listReportsPaginated({ page: 1, limit: 3 });

            expect(mockUserRepo.findAll).toHaveBeenCalledTimes(1);
            const [props] = mockUserRepo.findAll.mock.calls[0];
            expect(props.where).toEqual({ id: { in: ['doc-1', 'doc-2'] } });
        });

        it('skips the user query entirely when the page is empty', async () => {
            mockReportRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            const result = await service.listReportsPaginated({ page: 1, limit: 50 });

            expect(mockUserRepo.findAll).not.toHaveBeenCalled();
            expect(result.data).toEqual([]);
        });
    });

    // ─── Cross-Tenant Isolation ──────────────────────────────────

    describe('Cross-Tenant Isolation', () => {
        it('listReports should use the calling tenant context, not a hardcoded value', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'user-id-1' };
                if (key === 'tenantId') return 'tenant-B';
                return null;
            });

            const tenantBService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );

            const mockQb = createMockQueryBuilder();
            mockReportRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await tenantBService.listReports();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-B' });
            expect(mockQb.Where).not.toHaveBeenCalledWith({ tenantId: 'tenant-1' });
        });

        it('generateDnaReport should embed calling tenant context into job payload', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return { id: 'user-tenant-C' };
                if (key === 'tenantId') return 'tenant-C';
                return null;
            });

            const tenantCService = new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
            );
            mockUserRoleAssignmentRepo.findFirst.mockResolvedValue({
                id: 'ura-doctor-c',
                userId: 'doctor-1',
                tenantId: 'tenant-C',
                resourceStatus: ResourceStatusType.ENABLED,
            });

            await tenantCService.generateDnaReport('doctor-1', {});

            const [, payload] = mockQueue.add.mock.calls[0];
            expect(payload.tenantId).toBe('tenant-C');
            expect(payload.userId).toBe('user-tenant-C');
        });
    });

    /**
     * Multi-tenant isolation for DnaWritingStyleService.
     *
     * Audit C-9 — DNA writing style is derived from a doctor's PHI (transcripts,
     * summaries, prior notes). Allowing a Tenant-A admin to:
     *   - generate or read a writing-style report for a doctor in Tenant-B,
     *   - update or version a Tenant-B report by id,
     *   - read versions of a Tenant-B report,
     * leaks PHI-derived behavioural fingerprints across the tenant boundary.
     *
     * No GLOBAL_ADMIN bypass on the writing-style guards — even support flows
     * cannot read another tenant's PHI-derived artifact.
     */
    describe('Multi-tenant scoping', () => {
        describe('generateDnaReport', () => {
            it('rejects when doctorId has no role-assignment in the caller tenant', async () => {
                mockUserRoleAssignmentRepo.findFirst.mockResolvedValue(null);

                await expect(
                    service.generateDnaReport('foreign-doctor', {}),
                ).rejects.toThrow(NotFoundException);
                expect(mockQueue.add).not.toHaveBeenCalled();
            });

            it('does NOT bypass doctor-membership for GLOBAL_ADMIN (PHI guard)', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    if (key === 'user') return { id: 'super-admin', roles: ['GLOBAL_ADMIN'] };
                    if (key === 'tenantId') return 'tenant-1';
                    return null;
                });
                const superSvc = new DnaWritingStyleService(
                    mockReportRepo as never,
                    mockVersionRepo as never,
                    mockUsageRepo as never,
                    mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                    mockQueue as never,
                    mockEventEmitter as never,
                    mockClsService as never,
                    mockDatabaseService as never,
                );
                mockUserRoleAssignmentRepo.findFirst.mockResolvedValue(null);

                await expect(
                    superSvc.generateDnaReport('foreign-doctor', {}),
                ).rejects.toThrow(NotFoundException);
                expect(mockQueue.add).not.toHaveBeenCalled();
            });
        });

        describe('getDnaReport', () => {
            it('rejects when doctorId has no role-assignment in the caller tenant', async () => {
                mockUserRoleAssignmentRepo.findFirst.mockResolvedValue(null);

                await expect(service.getDnaReport('foreign-doctor')).rejects.toThrow(NotFoundException);
                expect(mockReportRepo.findLatestForDoctor).not.toHaveBeenCalled();
            });
        });

        describe('updateDnaReport', () => {
            it('throws NotFoundException when report belongs to another tenant', async () => {
                const foreignReport = createMockReportEntity({
                    id: 'report-foreign',
                    tenantId: 'tenant-2',
                    doctorId: 'user-id-1',
                });
                mockReportRepo.findById.mockResolvedValue(foreignReport);

                await expect(
                    service.updateDnaReport('report-foreign', { styleText: 'cross-tenant' }),
                ).rejects.toThrow(NotFoundException);
                expect(mockReportRepo.updateWithVersion).not.toHaveBeenCalled();
            });

            it('does NOT bypass tenant guard even with bypassOwnershipCheck=true', async () => {
                const foreignReport = createMockReportEntity({
                    id: 'report-foreign',
                    tenantId: 'tenant-2',
                    doctorId: 'user-id-1',
                });
                mockReportRepo.findById.mockResolvedValue(foreignReport);

                await expect(
                    service.updateDnaReport(
                        'report-foreign',
                        { styleText: 'admin update' },
                        { bypassOwnershipCheck: true },
                    ),
                ).rejects.toThrow(NotFoundException);
                expect(mockReportRepo.updateWithVersion).not.toHaveBeenCalled();
            });

            it('does NOT bypass tenant guard for GLOBAL_ADMIN (PHI guard)', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    if (key === 'user') return { id: 'super-admin', roles: ['GLOBAL_ADMIN'] };
                    if (key === 'tenantId') return 'tenant-1';
                    return null;
                });
                const superSvc = new DnaWritingStyleService(
                    mockReportRepo as never,
                    mockVersionRepo as never,
                    mockUsageRepo as never,
                    mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                    mockQueue as never,
                    mockEventEmitter as never,
                    mockClsService as never,
                    mockDatabaseService as never,
                );
                const foreignReport = createMockReportEntity({
                    id: 'report-foreign',
                    tenantId: 'tenant-2',
                });
                mockReportRepo.findById.mockResolvedValue(foreignReport);

                await expect(
                    superSvc.updateDnaReport('report-foreign', { styleText: 'x' }),
                ).rejects.toThrow(NotFoundException);
            });
        });

        describe('getVersions', () => {
            it('throws NotFoundException when report belongs to another tenant', async () => {
                const foreignReport = createMockReportEntity({
                    id: 'report-foreign',
                    tenantId: 'tenant-2',
                });
                mockReportRepo.findById.mockResolvedValue(foreignReport);

                await expect(service.getVersions('report-foreign')).rejects.toThrow(NotFoundException);
                expect(mockVersionRepo.findAll).not.toHaveBeenCalled();
            });
        });

        describe('getVersionsForDoctor', () => {
            it('throws NotFoundException when report belongs to another tenant', async () => {
                const foreignReport = createMockReportEntity({
                    id: 'report-foreign',
                    tenantId: 'tenant-2',
                    doctorId: 'doctor-foreign',
                });
                mockReportRepo.findById.mockResolvedValue(foreignReport);

                await expect(
                    service.getVersionsForDoctor('report-foreign', 'doctor-foreign'),
                ).rejects.toThrow(NotFoundException);
                expect(mockVersionRepo.findAll).not.toHaveBeenCalled();
            });
        });
    });

    // ─── per-doctor DNA settings (toggle) ───────────
    describe('DNA settings (Phase 6 doctor self-service toggle)', () => {
        const createMockPipelinePolicyService = () => ({
            getDnaSettings: vi.fn(),
            setDnaStyleForDoctor: vi.fn(),
        });

        let policy: ReturnType<typeof createMockPipelinePolicyService>;
        let svc: DnaWritingStyleService;

        const buildSvc = () =>
            new DnaWritingStyleService(
                mockReportRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockUserRoleAssignmentRepo as never, mockUserDepartmentRepo as never, mockUserRepo as never,
                mockQueue as never,
                mockEventEmitter as never,
                mockClsService as never,
                mockDatabaseService as never,
                policy as never,
            );

        beforeEach(() => {
            policy = createMockPipelinePolicyService();
            svc = buildSvc();
        });

        it('getDnaSettings delegates to PipelinePolicyService with the CLS tenant + doctorId and maps the response', async () => {
            policy.getDnaSettings.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: true, version: 2 });

            const res = await svc.getDnaSettings('doctor-id-1');

            expect(policy.getDnaSettings).toHaveBeenCalledWith({ tenantId: 'tenant-1', doctorId: 'doctor-id-1' });
            expect(res).toEqual({ doctorToggle: true, tenantEnabled: true, effective: true, version: 2 });
        });

        it('getDnaSettings throws BadRequestException when no tenant is in context', async () => {
            mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-id-1' } : null));

            await expect(svc.getDnaSettings('doctor-id-1')).rejects.toThrow(BadRequestException);
            expect(policy.getDnaSettings).not.toHaveBeenCalled();
        });

        it('setDnaEnabled writes the toggle via PipelinePolicyService and broadcasts ResourceUpdated', async () => {
            policy.setDnaStyleForDoctor.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false, version: 3 });

            const res = await svc.setDnaEnabled('doctor-id-1', { enabled: false, reason: 'opt out', expectedVersion: 2 });

            expect(policy.setDnaStyleForDoctor).toHaveBeenCalledWith({
                tenantId: 'tenant-1',
                doctorId: 'doctor-id-1',
                enabled: false,
                reason: 'opt out',
                expectedVersion: 2,
            });
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({ resourceId: 'doctor-id-1' }),
            );
            expect(res).toEqual({ doctorToggle: false, tenantEnabled: true, effective: false, version: 3 });
        });

        it('setDnaEnabled coerces an omitted/null `enabled` to null (clear the override)', async () => {
            policy.setDnaStyleForDoctor.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null, version: 0 });

            await svc.setDnaEnabled('doctor-id-1', { enabled: null });

            expect(policy.setDnaStyleForDoctor).toHaveBeenCalledWith(
                expect.objectContaining({ enabled: null, doctorId: 'doctor-id-1', tenantId: 'tenant-1' }),
            );
        });

        it('setDnaEnabled throws BadRequestException when no tenant is in context (no write, no broadcast)', async () => {
            mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-id-1' } : null));

            await expect(svc.setDnaEnabled('doctor-id-1', { enabled: true })).rejects.toThrow(BadRequestException);
            expect(policy.setDnaStyleForDoctor).not.toHaveBeenCalled();
            expect(mockEventEmitter.emit).not.toHaveBeenCalled();
        });
    });
});
