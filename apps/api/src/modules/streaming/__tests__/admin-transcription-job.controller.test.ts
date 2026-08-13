import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AdminTranscriptionJobController } from '../admin-transcription-job.controller';

// Admin (tenant-wide) transcription-job surface. Counterpart to
// the owner-scoped end-user `TranscriptionJobController`.
const mockJobService = {
  list: vi.fn(),
  getStatusCounts: vi.fn(),
  getByStatus: vi.fn(),
};

describe('AdminTranscriptionJobController', () => {
  let controller: AdminTranscriptionJobController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AdminTranscriptionJobController(mockJobService as any);
  });

  describe('list (tenant-wide)', () => {
    it('delegates to jobService.list (tenant-wide — never owner-scoped)', async () => {
      const paginated = { data: [], total: 0, page: 2, limit: 5, totalPages: 0 };
      mockJobService.list.mockResolvedValue(paginated);

      const result = await controller.list(2, 5);

      expect(mockJobService.list).toHaveBeenCalledWith(2, 5);
      expect(result).toEqual(paginated);
    });
  });

  describe('getStats (tenant-wide)', () => {
    it('delegates to jobService.getStatusCounts (tenant-wide)', async () => {
      const stats = { queued: 5, processing: 2, completed: 10, failed: 1, cancelled: 0, dead: 0 };
      mockJobService.getStatusCounts.mockResolvedValue(stats);

      const result = await controller.getStats();

      expect(mockJobService.getStatusCounts).toHaveBeenCalled();
      expect(result).toEqual(stats);
    });
  });

  describe('getByStatus (tenant-wide)', () => {
    it('delegates to jobService.getByStatus (tenant-wide)', async () => {
      const jobs = [{ id: 'job-1', status: 'COMPLETED' }];
      mockJobService.getByStatus.mockResolvedValue(jobs);

      const result = await controller.getByStatus('COMPLETED');

      expect(mockJobService.getByStatus).toHaveBeenCalledWith('COMPLETED');
      expect(result).toEqual(jobs);
    });
  });

  describe('access gate', () => {
    // `TranscriptionJob` is not a CASL subject in the policy seed, so the
    // tenant-wide admin view is gated on `manage Tenant` (TENANT_ADMIN /
    // GLOBAL_ADMIN). This also satisfies the F6 boot audit, which rejects an
    // empty @Authorize() on /admin routes.
    it('is class-gated by @CanManage(Tenant) so plain doctors/users are excluded', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AdminTranscriptionJobController) as
        Array<{ action: string; subject: string }> | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'Tenant' }]);
    });

    // The guard resolves permissions with getAllAndOverride, so a
    // class-only `manage Tenant` gate actually EXCLUDED tenant admins (the
    // seed grants them read/update Tenant, not manage). The design
    // scopes Audio Processing on AsrPipeline, which `tenant-full-access`
    // grants — so the reads carry a handler-level `read AsrPipeline` gate,
    // mirroring TenantBucketController's class-manage + handler-read shape.
    it.each(['list', 'getStats', 'getByStatus'] as const)(
      '%s is handler-gated by read AsrPipeline (tenant admins pass, doctors do not)',
      (method) => {
        const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AdminTranscriptionJobController.prototype[method]) as
          Array<{ action: string; subject: string }> | undefined;
        expect(meta).toEqual([{ action: 'read', subject: 'AsrPipeline' }]);
      },
    );
  });
});
