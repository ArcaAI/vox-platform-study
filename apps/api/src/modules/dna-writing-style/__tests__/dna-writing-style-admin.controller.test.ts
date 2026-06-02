import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleAdminController } from '../dna-writing-style-admin.controller';

const fakeReportEntity = {
    id: 'report-1',
    doctorId: 'doctor-1',
    reportData: { tone: 'formal', vocabulary: 'medical' },
    styleText: 'Concise, clinical tone.',
    isLatest: true,
    currentVersionNumber: 2,
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-15T00:00:00.000Z',
};

const fakeDashboard = {
    usersWithStyle: 3,
    avgVersions: 2.5,
    recentActivity: {
        dailyCounts: [
            { date: '2026-02-17', count: 1 },
            { date: '2026-02-18', count: 4 },
        ],
        latest: [
            {
                id: 'usage-1',
                doctorId: 'doctor-1',
                dnaReportId: 'report-1',
                dnaVersionNumber: 2,
                consultationId: 'consult-1',
                createdAt: '2026-02-18T10:00:00.000Z',
            },
        ],
        total: 5,
        windowDays: 30,
    },
};

const createMockDnaService = () => ({
    generateDnaReport: vi.fn(),
    getDnaReport: vi.fn(),
    updateDnaReport: vi.fn(),
    getVersions: vi.fn(),
    getVersionsForDoctor: vi.fn(),
    listReports: vi.fn(),
    getDashboard: vi.fn(),
});

const createMockDnaQueue = () => ({
    getJob: vi.fn(),
});

describe('DnaWritingStyleAdminController', () => {
    let controller: DnaWritingStyleAdminController;
    let mockDnaService: ReturnType<typeof createMockDnaService>;
    let mockDnaQueue: ReturnType<typeof createMockDnaQueue>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDnaService = createMockDnaService();
        mockDnaQueue = createMockDnaQueue();
        controller = new DnaWritingStyleAdminController(
            mockDnaService as any,
            mockDnaQueue as any,
        );
    });

    describe('GET /admin/dna-writing-styles (list)', () => {
        it('should call service.listReports and return paginated response', async () => {
            mockDnaService.listReports.mockResolvedValue([fakeReportEntity]);

            const result = await controller.list({ page: 1, limit: 10 } as any);

            expect(mockDnaService.listReports).toHaveBeenCalledWith({
                includeDisabled: false,
            });
            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(1);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(10);
        });

        it('should pass includeDisabled: true when query param is "true"', async () => {
            mockDnaService.listReports.mockResolvedValue([fakeReportEntity]);

            const result = await controller.list({ page: 1, limit: 10, includeDisabled: 'true' } as any);

            expect(mockDnaService.listReports).toHaveBeenCalledWith({
                includeDisabled: true,
            });
            expect(result.data).toHaveLength(1);
        });

        it('should pass includeDisabled: false when query param is absent', async () => {
            mockDnaService.listReports.mockResolvedValue([]);

            await controller.list({} as any);

            expect(mockDnaService.listReports).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should return paginated response with empty data when no reports exist', async () => {
            mockDnaService.listReports.mockResolvedValue([]);

            const result = await controller.list({ page: 1, limit: 10 } as any);

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should default to page 0 and limit 10 when no query params', async () => {
            mockDnaService.listReports.mockResolvedValue([fakeReportEntity]);

            const result = await controller.list({} as any);

            expect(result.page).toBe(0);
            expect(result.limit).toBe(10);
        });

        it('should pass includeDisabled: false when query param is "false" string', async () => {
            mockDnaService.listReports.mockResolvedValue([]);

            await controller.list({ includeDisabled: 'false' } as any);

            expect(mockDnaService.listReports).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should pass includeDisabled: false for non-boolean string values', async () => {
            mockDnaService.listReports.mockResolvedValue([]);

            await controller.list({ includeDisabled: '1' } as any);

            expect(mockDnaService.listReports).toHaveBeenCalledWith({
                includeDisabled: false,
            });
        });

        it('should return mixed ENABLED and DISABLED reports when includeDisabled is true', async () => {
            const enabledReport = { ...fakeReportEntity, id: 'r1', resourceStatus: 'ENABLED' };
            const disabledReport = { ...fakeReportEntity, id: 'r2', resourceStatus: 'DISABLED' };
            mockDnaService.listReports.mockResolvedValue([enabledReport, disabledReport]);

            const result = await controller.list({ page: 1, limit: 10, includeDisabled: 'true' } as any);

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
        });

        it('should combine includeDisabled with pagination correctly', async () => {
            const reports = Array.from({ length: 5 }, (_, i) => ({
                ...fakeReportEntity,
                id: `r${i}`,
                resourceStatus: i % 2 === 0 ? 'ENABLED' : 'DISABLED',
            }));
            mockDnaService.listReports.mockResolvedValue(reports);

            const result = await controller.list({ page: 1, limit: 2, includeDisabled: 'true' } as any);

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(5);
        });
    });

    describe('PATCH /admin/dna-writing-styles/:reportId (update)', () => {
        // ─── TASK-326 X7 / D-2 — If-Match → expectedVersion fold ─────────
        // The route is `@RequiresIfMatch()`; the `@ExpectedVersion()` param
        // decorator parses `If-Match` into a number (or 428s when missing).
        // The controller folds that value onto the DTO's `expectedVersion`
        // (header wins) while preserving the admin `bypassOwnershipCheck`.
        it('folds the If-Match header into expectedVersion (header wins) and preserves bypassOwnershipCheck (TASK-326 X7 / D-2)', async () => {
            mockDnaService.updateDnaReport.mockResolvedValue(fakeReportEntity);

            await controller.update('report-1', { styleText: 'Updated', expectedVersion: 99 } as any, 7);

            expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith(
                'report-1',
                expect.objectContaining({ styleText: 'Updated', expectedVersion: 7 }),
                { bypassOwnershipCheck: true },
            );
        });

        it('forwards the body unchanged when no If-Match header resolved (expectedFromHeader undefined) (TASK-326 X7 / D-2)', async () => {
            const body = { styleText: 'Updated', changeReason: 'Edit', expectedVersion: 5 };
            mockDnaService.updateDnaReport.mockResolvedValue(fakeReportEntity);

            await controller.update('report-1', body as any, undefined);

            expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith(
                'report-1',
                body,
                { bypassOwnershipCheck: true },
            );
        });

        it('should call service.updateDnaReport with bypassOwnershipCheck: true', async () => {
            const updatedReport = { ...fakeReportEntity, resourceStatus: 'DISABLED' };
            mockDnaService.updateDnaReport.mockResolvedValue(updatedReport);

            const result = await controller.update('report-1', { resourceStatus: 'DISABLED' } as any);

            expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith(
                'report-1',
                { resourceStatus: 'DISABLED' },
                { bypassOwnershipCheck: true },
            );
            expect(result.resourceStatus).toBe('DISABLED');
        });

        it('should toggle resourceStatus from ENABLED to DISABLED', async () => {
            const disabledReport = { ...fakeReportEntity, resourceStatus: 'DISABLED' };
            mockDnaService.updateDnaReport.mockResolvedValue(disabledReport);

            const result = await controller.update('report-1', { resourceStatus: 'DISABLED' } as any);

            expect(result.resourceStatus).toBe('DISABLED');
        });

        it('should toggle resourceStatus from DISABLED to ENABLED', async () => {
            const enabledReport = { ...fakeReportEntity, resourceStatus: 'ENABLED' };
            mockDnaService.updateDnaReport.mockResolvedValue(enabledReport);

            const result = await controller.update('report-1', { resourceStatus: 'ENABLED' } as any);

            expect(result.resourceStatus).toBe('ENABLED');
        });

        it('should propagate NotFoundException from service when report not found', async () => {
            const { NotFoundException } = await import('@nestjs/common');
            mockDnaService.updateDnaReport.mockRejectedValue(
                new NotFoundException('DNA report nonexistent not found'),
            );

            await expect(
                controller.update('nonexistent', { resourceStatus: 'DISABLED' } as any),
            ).rejects.toThrow(NotFoundException);
        });

        it('should support content update alongside resourceStatus toggle', async () => {
            const updatedReport = {
                ...fakeReportEntity,
                styleText: 'New style',
                resourceStatus: 'DISABLED',
                currentVersionNumber: 3,
            };
            mockDnaService.updateDnaReport.mockResolvedValue(updatedReport);

            const result = await controller.update('report-1', {
                styleText: 'New style',
                resourceStatus: 'DISABLED',
            } as any);

            expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith(
                'report-1',
                { styleText: 'New style', resourceStatus: 'DISABLED' },
                { bypassOwnershipCheck: true },
            );
            expect(result.styleText).toBe('New style');
            expect(result.resourceStatus).toBe('DISABLED');
        });
    });

    describe('POST /admin/dna-writing-styles/generate/:doctorId', () => {
        it('should call service.generateDnaReport with specified doctorId', async () => {
            const dto = { textSamples: ['Clinical note for doctor-5'] };
            mockDnaService.generateDnaReport.mockResolvedValue({ jobId: 'job-admin-1', status: 'PENDING' });

            const result = await controller.generateForDoctor('doctor-5', dto as any);

            expect(mockDnaService.generateDnaReport).toHaveBeenCalledWith('doctor-5', dto);
            expect(result.jobId).toBe('job-admin-1');
        });
    });

    describe('GET /admin/dna-writing-styles/:reportId/versions (getVersions)', () => {
        it('should call service.getVersions without ownership check', async () => {
            mockDnaService.getVersions.mockResolvedValue([
                {
                    id: 'version-1',
                    dnaReportId: 'report-1',
                    versionNumber: 1,
                    reportData: { tone: 'informal' },
                    styleText: 'Original style text.',
                    changeReason: 'Initial generation',
                    changedBy: 'system',
                    createdAt: '2025-12-01T00:00:00.000Z',
                },
                {
                    id: 'version-2',
                    dnaReportId: 'report-1',
                    versionNumber: 2,
                    reportData: { tone: 'formal' },
                    styleText: 'Updated style text.',
                    changeReason: 'Refinement',
                    changedBy: 'doctor-1',
                    createdAt: '2025-12-15T00:00:00.000Z',
                },
            ]);

            const result = await controller.getVersions('report-1');

            expect(mockDnaService.getVersions).toHaveBeenCalledWith('report-1');
            expect(result).toHaveLength(2);
            expect(result[0].versionNumber).toBe(1);
            expect(result[1].versionNumber).toBe(2);
        });

        it('should return empty array when no versions exist', async () => {
            mockDnaService.getVersions.mockResolvedValue([]);

            const result = await controller.getVersions('report-no-versions');

            expect(mockDnaService.getVersions).toHaveBeenCalledWith('report-no-versions');
            expect(result).toEqual([]);
        });

        it('should call getVersions (not getVersionsForDoctor) to bypass ownership', async () => {
            mockDnaService.getVersions.mockResolvedValue([]);

            await controller.getVersions('report-1');

            expect(mockDnaService.getVersions).toHaveBeenCalledWith('report-1');
            expect(mockDnaService.getVersionsForDoctor).not.toHaveBeenCalled();
        });
    });

    describe('GET /admin/dna-writing-styles/dashboard (TASK-328 A5)', () => {
        it('passes the tenantId query param through to the service and returns the DTO', async () => {
            mockDnaService.getDashboard.mockResolvedValue(fakeDashboard);

            const result = await controller.getDashboard('tenant-7');

            expect(mockDnaService.getDashboard).toHaveBeenCalledWith('tenant-7');
            expect(result).toBe(fakeDashboard);
        });

        it('passes undefined to the service when no tenantId is provided (tenant admin / all-tenants)', async () => {
            mockDnaService.getDashboard.mockResolvedValue(fakeDashboard);

            await controller.getDashboard(undefined);

            expect(mockDnaService.getDashboard).toHaveBeenCalledWith(undefined);
        });

        it('returns the typed aggregate shape (usersWithStyle, avgVersions, recentActivity)', async () => {
            mockDnaService.getDashboard.mockResolvedValue(fakeDashboard);

            const result = await controller.getDashboard('tenant-7');

            expect(result.usersWithStyle).toBe(3);
            expect(result.avgVersions).toBe(2.5);
            expect(result.recentActivity.total).toBe(5);
            expect(result.recentActivity.windowDays).toBe(30);
            expect(result.recentActivity.dailyCounts).toHaveLength(2);
            expect(result.recentActivity.latest[0].id).toBe('usage-1');
        });
    });

    describe('GET /admin/dna-writing-styles/jobs/:jobId', () => {
        it('should return completed status when job is finished', async () => {
            mockDnaQueue.getJob.mockResolvedValue({
                id: 'job-1',
                getState: vi.fn().mockResolvedValue('completed'),
                returnvalue: { reportId: 'report-1' },
                failedReason: undefined,
            });

            const result = await controller.getJobStatus('job-1');

            expect(result.jobId).toBe('job-1');
            expect(result.status).toBe('completed');
            expect(result.result).toEqual({ reportId: 'report-1' });
        });

        it('should return processing status when job is active', async () => {
            mockDnaQueue.getJob.mockResolvedValue({
                id: 'job-2',
                getState: vi.fn().mockResolvedValue('active'),
                returnvalue: undefined,
                failedReason: undefined,
            });

            const result = await controller.getJobStatus('job-2');

            expect(result.jobId).toBe('job-2');
            expect(result.status).toBe('processing');
        });

        it('should return failed status with error when job failed', async () => {
            mockDnaQueue.getJob.mockResolvedValue({
                id: 'job-3',
                getState: vi.fn().mockResolvedValue('failed'),
                returnvalue: undefined,
                failedReason: 'SMR service unavailable',
            });

            const result = await controller.getJobStatus('job-3');

            expect(result.jobId).toBe('job-3');
            expect(result.status).toBe('failed');
            expect(result.error).toBe('SMR service unavailable');
        });

        it('should return queued status when job is waiting', async () => {
            mockDnaQueue.getJob.mockResolvedValue({
                id: 'job-4',
                getState: vi.fn().mockResolvedValue('waiting'),
                returnvalue: undefined,
                failedReason: undefined,
            });

            const result = await controller.getJobStatus('job-4');

            expect(result.jobId).toBe('job-4');
            expect(result.status).toBe('queued');
        });

        it('should throw NotFoundException when job does not exist', async () => {
            mockDnaQueue.getJob.mockResolvedValue(null);

            await expect(controller.getJobStatus('nonexistent')).rejects.toThrow();
        });
    });
});
