import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleController } from '../dna-writing-style.controller';

const fakeReportEntity = {
    id: 'report-1',
    doctorId: 'doctor-1',
    reportData: { tone: 'formal', vocabulary: 'medical' },
    styleText: 'Concise, clinical tone with structured paragraphs.',
    isLatest: true,
    currentVersionNumber: 2,
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-15T00:00:00.000Z',
};

const fakeVersionEntity = {
    id: 'version-1',
    dnaReportId: 'report-1',
    versionNumber: 1,
    reportData: { tone: 'informal' },
    styleText: 'Original style text.',
    changeReason: 'Initial generation',
    changedBy: 'system',
    createdAt: '2025-12-01T00:00:00.000Z',
};

const createMockDnaService = () => ({
    generateDnaReport: vi.fn(),
    getDnaReport: vi.fn(),
    updateDnaReport: vi.fn(),
    setDefaultReport: vi.fn(),
    getVersions: vi.fn(),
    getVersionsForDoctor: vi.fn(),
    listReports: vi.fn(),
});

const createMockClsService = (userId: string | null = 'doctor-1') => ({
    get: vi.fn((key: string) => {
        if (key === 'user') return userId ? { id: userId, tenantId: 'tenant-1' } : null;
        return undefined;
    }),
});

const createMockDnaQueue = () => ({
    getJob: vi.fn(),
});

describe('DnaWritingStyleController', () => {
    let controller: DnaWritingStyleController;
    let mockDnaService: ReturnType<typeof createMockDnaService>;
    let mockClsService: ReturnType<typeof createMockClsService>;
    let mockDnaQueue: ReturnType<typeof createMockDnaQueue>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDnaService = createMockDnaService();
        mockClsService = createMockClsService();
        mockDnaQueue = createMockDnaQueue();
        controller = new DnaWritingStyleController(
            mockDnaService as any,
            mockClsService as any,
            mockDnaQueue as any,
        );
    });

    describe('POST /dna-writing-styles/generate', () => {
        it('should call service.generateDnaReport with current user doctorId', async () => {
            const dto = { textSamples: ['Sample clinical note...'] };
            mockDnaService.generateDnaReport.mockResolvedValue({ jobId: 'job-1', status: 'PENDING' });

            const result = await controller.generate(dto as any);

            expect(mockDnaService.generateDnaReport).toHaveBeenCalledWith('doctor-1', dto);
            expect(result).toEqual({ jobId: 'job-1', status: 'PENDING' });
        });

        it('should return jobId and status from service', async () => {
            mockDnaService.generateDnaReport.mockResolvedValue({ jobId: 'job-abc', status: 'PENDING' });

            const result = await controller.generate({ textSamples: ['note'] } as any);

            expect(result.jobId).toBe('job-abc');
            expect(result.status).toBe('PENDING');
        });
    });

    describe('GET /dna-writing-styles/my-style', () => {
        it('should call service.getDnaReport with current user id', async () => {
            mockDnaService.getDnaReport.mockResolvedValue(fakeReportEntity);

            await controller.getMyStyle();

            expect(mockDnaService.getDnaReport).toHaveBeenCalledWith('doctor-1');
        });

        it('should return the report when found', async () => {
            mockDnaService.getDnaReport.mockResolvedValue(fakeReportEntity);

            const result = await controller.getMyStyle();

            expect(result).toEqual(fakeReportEntity);
        });

        it('should throw NotFoundException when no report exists', async () => {
            mockDnaService.getDnaReport.mockResolvedValue(null);

            await expect(controller.getMyStyle()).rejects.toThrow();
        });
    });

    describe('GET /dna-writing-styles/doctor/:doctorId', () => {
        it('should call service.getDnaReport when doctorId matches current user', async () => {
            mockDnaService.getDnaReport.mockResolvedValue(fakeReportEntity);

            await controller.getByDoctor('doctor-1');

            expect(mockDnaService.getDnaReport).toHaveBeenCalledWith('doctor-1');
        });

        it('should throw ForbiddenException when doctorId does not match current user', async () => {
            await expect(controller.getByDoctor('doctor-99')).rejects.toThrow(
                "Cannot access another doctor's DNA writing style",
            );
            expect(mockDnaService.getDnaReport).not.toHaveBeenCalled();
        });

        it('should throw NotFoundException when no report exists for doctor', async () => {
            mockDnaService.getDnaReport.mockResolvedValue(null);

            await expect(controller.getByDoctor('doctor-1')).rejects.toThrow();
        });
    });

    describe('PATCH /dna-writing-styles/:reportId', () => {
        it('should call service.updateDnaReport with reportId and dto', async () => {
            const dto = { styleText: 'Updated style', changeReason: 'Refinement' };
            mockDnaService.updateDnaReport.mockResolvedValue({ ...fakeReportEntity, styleText: 'Updated style' });

            const result = await controller.update('report-1', dto as any);

            expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith('report-1', dto);
            expect(result.styleText).toBe('Updated style');
        });
    });

    describe('GET /dna-writing-styles/:reportId/versions', () => {
        it('should call service.getVersionsForDoctor with reportId and current user', async () => {
            mockDnaService.getVersionsForDoctor.mockResolvedValue([fakeVersionEntity]);

            const result = await controller.getVersions('report-1');

            expect(mockDnaService.getVersionsForDoctor).toHaveBeenCalledWith('report-1', 'doctor-1');
            expect(result).toHaveLength(1);
            expect(result[0].versionNumber).toBe(1);
        });

        it('should return empty array when no versions exist', async () => {
            mockDnaService.getVersionsForDoctor.mockResolvedValue([]);

            const result = await controller.getVersions('report-1');

            expect(result).toEqual([]);
        });
    });

    // ─── TASK-329 P5 — owner-scoped report history (GET mine) ───
    describe('GET /dna-writing-styles/mine', () => {
        it('should list the current doctor\'s own reports', async () => {
            const reports = [fakeReportEntity, { ...fakeReportEntity, id: 'report-2', isLatest: false }];
            mockDnaService.listReports.mockResolvedValue(reports);

            const result = await controller.getMine();

            expect(mockDnaService.listReports).toHaveBeenCalledWith({ doctorId: 'doctor-1' });
            expect(result).toHaveLength(2);
        });

        it('should return an empty array when the doctor has no reports', async () => {
            mockDnaService.listReports.mockResolvedValue([]);

            const result = await controller.getMine();

            expect(result).toEqual([]);
        });
    });

    // ─── TASK-329 P5 — set-default (PATCH :reportId/default) ─────
    describe('PATCH /dna-writing-styles/:reportId/default', () => {
        it('should call service.setDefaultReport with the reportId', async () => {
            mockDnaService.setDefaultReport.mockResolvedValue({ ...fakeReportEntity, isLatest: true });

            const result = await controller.setDefault('report-1');

            expect(mockDnaService.setDefaultReport).toHaveBeenCalledWith('report-1');
            expect(result.isLatest).toBe(true);
        });
    });

    describe('GET /dna-writing-styles/jobs/:jobId', () => {
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

        it('should throw NotFoundException when job does not exist', async () => {
            mockDnaQueue.getJob.mockResolvedValue(null);

            await expect(controller.getJobStatus('missing-job')).rejects.toThrow();
        });
    });

    describe('user context validation', () => {
        it('should throw UnauthorizedException when user context is missing', async () => {
            const noUserCls = createMockClsService(null);
            const ctrlNoUser = new DnaWritingStyleController(
                mockDnaService as any,
                noUserCls as any,
                mockDnaQueue as any,
            );

            await expect(
                ctrlNoUser.generate({ textSamples: ['note'] } as any),
            ).rejects.toThrow('User context not available');
        });
    });
});
