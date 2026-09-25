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

      // TASK-999 — the query moved onto a validated DTO so `jobType` could be
      // declared; `forbidNonWhitelisted` rejects an undeclared query field, so it
      // could not stay a loose `@Query('name')` param.
      const result = await controller.list({ page: 2, limit: 5 } as never);

      expect(mockJobService.list).toHaveBeenCalledWith(2, 5, undefined);
      expect(result).toEqual(paginated);
    });

    it('passes the jobType filter straight through, and BOTH kinds when it is absent', async () => {
      // TASK-999 (D-5(a)) — the list now carries batch jobs AND the realtime
      // sessions that became `jobType = STREAMING` rows. Absent must mean both:
      // defaulting to BATCH would hide every new row from existing readers.
      mockJobService.list.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });

      await controller.list({ jobType: 'STREAMING' } as never);
      expect(mockJobService.list).toHaveBeenCalledWith(1, 20, 'STREAMING');

      await controller.list({} as never);
      expect(mockJobService.list).toHaveBeenLastCalledWith(1, 20, undefined);
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
    // The class-level gate is `manage Tenant` (TENANT_ADMIN / SUPER_ADMIN).
    // This also satisfies the F6 boot audit, which rejects an empty
    // @Authorize() on /admin routes.
    it('is class-gated by @CanManage(Tenant) so plain doctors/users are excluded', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AdminTranscriptionJobController) as
        Array<{ action: string; subject: string }> | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'Tenant' }]);
    });

    // The guard resolves permissions with getAllAndOverride, so a
    // class-only `manage Tenant` gate actually EXCLUDED tenant admins (the
    // seed grants them read/update Tenant, not manage) — so the reads carry a
    // handler-level `read` gate, mirroring TenantBucketController's
    // class-manage + handler-read shape.
    //
    // TASK-1006 — the subject is the resource these routes actually read,
    // `TranscriptionJob`. It was `AsrPipeline`, the retired pipeline stack's
    // subject, which outlived the tables it named.
    it.each(['list', 'getStats', 'getByStatus'] as const)(
      '%s is handler-gated by read TranscriptionJob (tenant admins pass, doctors do not)',
      (method) => {
        const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AdminTranscriptionJobController.prototype[method]) as
          Array<{ action: string; subject: string }> | undefined;
        expect(meta).toEqual([{ action: 'read', subject: 'TranscriptionJob' }]);
      },
    );
  });
});
