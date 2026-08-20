import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators';
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
  getRedactionRules: vi.fn(),
  updateDnaReport: vi.fn(),
  setDefaultReport: vi.fn(),
  getVersions: vi.fn(),
  getVersionsForDoctor: vi.fn(),
  listReports: vi.fn(),
  // Per-doctor DNA on/off settings.
  getDnaSettings: vi.fn(),
  setDnaEnabled: vi.fn(),
  // Erasure (INV-240) — the other half of the opt-out.
  resetMyDnaProfile: vi.fn(),
  deleteReport: vi.fn(),
});

const createMockClsService = (userId: string | null = 'doctor-1', session: { roles?: string[]; impersonatedBy?: string } = {}) => ({
  get: vi.fn((key: string) => {
    if (key === 'user') return userId ? { id: userId, tenantId: 'tenant-1', ...session } : null;
    // C-01: the job routes read the ACTIVE tenant to gate job ownership.
    if (key === 'tenantId') return 'tenant-1';
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
    controller = new DnaWritingStyleController(mockDnaService as any, mockClsService as any, mockDnaQueue as any);
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

    // ─── Doctor-scope gate (defense-in-depth) ─────────────────────────
    // The UI hides the generate trigger for a non-impersonating admin, but
    // the route trusts `getDoctorId()` = caller, so a bare admin could
    // self-generate a DNA style under their OWN account (isolation break).
    // The handler now rejects an admin caller that is not acting as a doctor.
    it('rejects an admin caller without active doctor scope (no impersonation)', async () => {
      const adminCls = createMockClsService('admin-1', { roles: ['TENANT_ADMIN'] });
      const adminController = new DnaWritingStyleController(mockDnaService as any, adminCls as any, mockDnaQueue as any);

      await expect(adminController.generate({ textSamples: ['note'] } as any)).rejects.toThrow(/impersonate a doctor/i);
      expect(mockDnaService.generateDnaReport).not.toHaveBeenCalled();
    });

    it('rejects a super admin caller without active doctor scope', async () => {
      const adminCls = createMockClsService('admin-2', { roles: ['SUPER_ADMIN'] });
      const adminController = new DnaWritingStyleController(mockDnaService as any, adminCls as any, mockDnaQueue as any);

      await expect(adminController.generate({ textSamples: ['note'] } as any)).rejects.toThrow(/impersonate a doctor/i);
      expect(mockDnaService.generateDnaReport).not.toHaveBeenCalled();
    });

    it('allows an admin who is actively impersonating a doctor', async () => {
      // Impersonation swaps the CLS user to the doctor (DOCTOR role) and
      // stamps `impersonatedBy` with the admin id — the gate must pass.
      const impersonatedCls = createMockClsService('doctor-7', { roles: ['DOCTOR'], impersonatedBy: 'admin-1' });
      const impersonatedController = new DnaWritingStyleController(mockDnaService as any, impersonatedCls as any, mockDnaQueue as any);
      mockDnaService.generateDnaReport.mockResolvedValue({ jobId: 'job-imp', status: 'PENDING' });

      const result = await impersonatedController.generate({ textSamples: ['note'] } as any);

      expect(mockDnaService.generateDnaReport).toHaveBeenCalledWith('doctor-7', { textSamples: ['note'] });
      expect(result.jobId).toBe('job-imp');
    });

    it('allows a real doctor caller (non-admin)', async () => {
      const doctorCls = createMockClsService('doctor-1', { roles: ['DOCTOR'] });
      const doctorController = new DnaWritingStyleController(mockDnaService as any, doctorCls as any, mockDnaQueue as any);
      mockDnaService.generateDnaReport.mockResolvedValue({ jobId: 'job-doc', status: 'PENDING' });

      await doctorController.generate({ textSamples: ['note'] } as any);

      expect(mockDnaService.generateDnaReport).toHaveBeenCalledWith('doctor-1', { textSamples: ['note'] });
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

  describe('GET /dna-writing-styles/my-style/redaction-rules', () => {
    it('returns the caller doctor decrypted redaction rule set', async () => {
      const ruleSet = { rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: "patient's employer" }] };
      mockDnaService.getRedactionRules.mockResolvedValue(ruleSet);

      const result = await controller.getMyRedactionRules();

      expect(mockDnaService.getRedactionRules).toHaveBeenCalledWith('doctor-1');
      expect(result).toEqual(ruleSet);
    });

    it('returns the well-formed empty set (never 404) when no rules are configured', async () => {
      mockDnaService.getRedactionRules.mockResolvedValue({ rules: [] });

      const result = await controller.getMyRedactionRules();

      expect(result).toEqual({ rules: [] });
    });
  });

  describe('GET /dna-writing-styles/doctor/:doctorId', () => {
    it('should call service.getDnaReport when doctorId matches current user', async () => {
      mockDnaService.getDnaReport.mockResolvedValue(fakeReportEntity);

      await controller.getByDoctor('doctor-1');

      expect(mockDnaService.getDnaReport).toHaveBeenCalledWith('doctor-1');
    });

    it('should throw ForbiddenException when doctorId does not match current user', async () => {
      await expect(controller.getByDoctor('doctor-99')).rejects.toThrow("Cannot access another doctor's DNA writing style");
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

      const result = await controller.update('report-1', dto as any, undefined);

      expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith('report-1', dto);
      expect(result.styleText).toBe('Updated style');
    });

    // ─── Doctor self-edit OCC ──────────────────────────────────────────
    // The doctor PATCH route now mirrors the admin route: `@RequiresIfMatch()`
    // + `@ExpectedVersion()` so super/super admin (under a tenant), tenant
    // admin, the doctor, and an admin-impersonated doctor all manage their
    // DNA report under real optimistic concurrency control.
    it('requires the If-Match header on the update route (@RequiresIfMatch metadata)', () => {
      const reflector = new Reflector();
      const flag = reflector.get(REQUIRES_IF_MATCH_KEY, DnaWritingStyleController.prototype.update);
      expect(flag).toBe(true);
    });

    it('folds the If-Match header into expectedVersion (header wins)', async () => {
      mockDnaService.updateDnaReport.mockResolvedValue(fakeReportEntity);

      await controller.update('report-1', { styleText: 'Updated', expectedVersion: 99 } as any, 7);

      expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith('report-1', expect.objectContaining({ styleText: 'Updated', expectedVersion: 7 }));
    });

    it('forwards the body unchanged when no If-Match header resolved (expectedFromHeader undefined)', async () => {
      const body = { styleText: 'Updated', changeReason: 'Edit', expectedVersion: 5 };
      mockDnaService.updateDnaReport.mockResolvedValue(fakeReportEntity);

      await controller.update('report-1', body as any, undefined);

      expect(mockDnaService.updateDnaReport).toHaveBeenCalledWith('report-1', body);
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

  // ─── Owner-scoped report history (GET mine) ─────────────────
  describe('GET /dna-writing-styles/mine', () => {
    it("should list the current doctor's own reports", async () => {
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

  // ─── Set-default (PATCH :reportId/default) ────────────────────
  describe('PATCH /dna-writing-styles/:reportId/default', () => {
    it('should thread the reportId and the parsed If-Match version into service.setDefaultReport', async () => {
      mockDnaService.setDefaultReport.mockResolvedValue({ ...fakeReportEntity, isLatest: true });

      // The route is `@RequiresIfMatch()`, so `@ExpectedVersion()` has already
      // parsed `If-Match: "7"` into `7` by the time the handler runs.
      const result = await controller.setDefault('report-1', 7);

      expect(mockDnaService.setDefaultReport).toHaveBeenCalledWith('report-1', 7);
      expect(result.isLatest).toBe(true);
    });

    it('should pass undefined through when no If-Match version was parsed', async () => {
      mockDnaService.setDefaultReport.mockResolvedValue({ ...fakeReportEntity, isLatest: true });

      await controller.setDefault('report-1', undefined);

      expect(mockDnaService.setDefaultReport).toHaveBeenCalledWith('report-1', undefined);
    });
  });

  describe('GET /dna-writing-styles/jobs/:jobId', () => {
    it('should return completed status when job is finished', async () => {
      mockDnaQueue.getJob.mockResolvedValue({
        id: 'job-1',
        // C-01 owner fields stamped at enqueue time.
        data: { tenantId: 'tenant-1', doctorId: 'doctor-1', userId: 'doctor-1' },
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
        data: { tenantId: 'tenant-1', doctorId: 'doctor-1', userId: 'doctor-1' },
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

  // ─── Per-doctor DNA on/off settings ──────────────────────────────────
  describe('GET /dna-writing-styles/settings', () => {
    it('returns the caller doctor settings (delegates with current user id)', async () => {
      mockDnaService.getDnaSettings.mockResolvedValue({ doctorToggle: true, tenantEnabled: true, effective: true, version: 2 });

      const result = await controller.getSettings();

      expect(mockDnaService.getDnaSettings).toHaveBeenCalledWith('doctor-1');
      expect(result.effective).toBe(true);
      expect(result.version).toBe(2);
    });
  });

  describe('PUT /dna-writing-styles/settings', () => {
    it('writes the toggle for the caller doctor (delegates with current user id + dto)', async () => {
      const dto = { enabled: false, reason: 'prefer my own voice' };
      mockDnaService.setDnaEnabled.mockResolvedValue({ doctorToggle: false, tenantEnabled: true, effective: false, version: 3 });

      const result = await controller.setSettings(dto as never, undefined);

      expect(mockDnaService.setDnaEnabled).toHaveBeenCalledWith('doctor-1', dto);
      expect(result.effective).toBe(false);
    });

    it('folds the If-Match header into expectedVersion (header wins)', async () => {
      mockDnaService.setDnaEnabled.mockResolvedValue({ doctorToggle: true, tenantEnabled: true, effective: true, version: 4 });

      await controller.setSettings({ enabled: true, expectedVersion: 99 } as never, 3);

      expect(mockDnaService.setDnaEnabled).toHaveBeenCalledWith('doctor-1', expect.objectContaining({ enabled: true, expectedVersion: 3 }));
    });

    it('rejects a non-impersonating admin (doctor-scope gate, mirrors generate)', async () => {
      const adminCls = createMockClsService('admin-1', { roles: ['TENANT_ADMIN'] });
      const adminController = new DnaWritingStyleController(mockDnaService as any, adminCls as any, mockDnaQueue as any);

      await expect(adminController.setSettings({ enabled: true } as never, undefined)).rejects.toThrow(/impersonate a doctor/i);
      expect(mockDnaService.setDnaEnabled).not.toHaveBeenCalled();
    });
  });

  describe('user context validation', () => {
    it('should throw UnauthorizedException when user context is missing', async () => {
      const noUserCls = createMockClsService(null);
      const ctrlNoUser = new DnaWritingStyleController(mockDnaService as any, noUserCls as any, mockDnaQueue as any);

      await expect(ctrlNoUser.generate({ textSamples: ['note'] } as any)).rejects.toThrow('User context not available');
    });
  });

  // ─── Erasure routes (INV-240) ────────────────────────────────────────────

  describe('resetMyStyle (DELETE my-style)', () => {
    it('delegates to the service and returns erasure counts', async () => {
      const doctorCls = createMockClsService('doctor-1', { roles: ['DOCTOR'] });
      const ctrl = new DnaWritingStyleController(mockDnaService as any, doctorCls as any, mockDnaQueue as any);
      mockDnaService.resetMyDnaProfile.mockResolvedValue({ doctorId: 'doctor-1', deletedReports: 2, deletedVersions: 3 });

      const result = await ctrl.resetMyStyle();

      expect(mockDnaService.resetMyDnaProfile).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ doctorId: 'doctor-1', deletedReports: 2, deletedVersions: 3 });
    });

    it('refuses a non-impersonating admin acting under their own account', async () => {
      const adminCls = createMockClsService('admin-1', { roles: ['TENANT_ADMIN'] });
      const ctrl = new DnaWritingStyleController(mockDnaService as any, adminCls as any, mockDnaQueue as any);

      await expect(ctrl.resetMyStyle()).rejects.toThrow();
      expect(mockDnaService.resetMyDnaProfile).not.toHaveBeenCalled();
    });
  });

  describe('deleteReport (DELETE :reportId)', () => {
    it('passes the reportId through to the service', async () => {
      const doctorCls = createMockClsService('doctor-1', { roles: ['DOCTOR'] });
      const ctrl = new DnaWritingStyleController(mockDnaService as any, doctorCls as any, mockDnaQueue as any);
      mockDnaService.deleteReport.mockResolvedValue({ doctorId: 'doctor-1', deletedReports: 1, deletedVersions: 1 });

      const result = await ctrl.deleteReport('report-9');

      expect(mockDnaService.deleteReport).toHaveBeenCalledWith('report-9');
      expect(result.deletedReports).toBe(1);
    });

    it('propagates the service 404 for a cross-tenant report (no 403 leak)', async () => {
      const doctorCls = createMockClsService('doctor-1', { roles: ['DOCTOR'] });
      const ctrl = new DnaWritingStyleController(mockDnaService as any, doctorCls as any, mockDnaQueue as any);
      mockDnaService.deleteReport.mockRejectedValue(new NotFoundException('DNA report foreign not found'));

      await expect(ctrl.deleteReport('foreign')).rejects.toThrow(NotFoundException);
    });
  });
});
