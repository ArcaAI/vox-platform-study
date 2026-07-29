import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { SchedulerAdminController } from '../scheduler-admin.controller';

// Guarded admin surface over the existing
// scheduler-admin application layer (@nestjs/schedule SchedulerRegistry +
// dynamic GlobalSetting-backed cron). Thin delegate to ISchedulerAdminService.
const mockSchedulerService = {
  listSchedulers: vi.fn(),
  pauseScheduler: vi.fn(),
  resumeScheduler: vi.fn(),
  updateSchedulerCron: vi.fn(),
  toggleScheduler: vi.fn(),
};

describe('SchedulerAdminController', () => {
  let controller: SchedulerAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new SchedulerAdminController(mockSchedulerService as never);
  });

  it('lists all schedulers', () => {
    const schedulers = [{ name: 'dna-regeneration', type: 'cron', source: 'dynamic' }];
    mockSchedulerService.listSchedulers.mockReturnValue(schedulers);

    const result = controller.listSchedulers();

    expect(mockSchedulerService.listSchedulers).toHaveBeenCalledWith();
    expect(result).toEqual(schedulers);
  });

  it('pauses a scheduler and returns an ack', () => {
    mockSchedulerService.pauseScheduler.mockReturnValue(undefined);

    const result = controller.pauseScheduler('dna-regeneration');

    expect(mockSchedulerService.pauseScheduler).toHaveBeenCalledWith('dna-regeneration');
    expect(result).toEqual({ success: true });
  });

  it('resumes a scheduler and returns an ack', () => {
    mockSchedulerService.resumeScheduler.mockReturnValue(undefined);

    const result = controller.resumeScheduler('dna-regeneration');

    expect(mockSchedulerService.resumeScheduler).toHaveBeenCalledWith('dna-regeneration');
    expect(result).toEqual({ success: true });
  });

  it('updates a dynamic scheduler cron expression', async () => {
    const updated = { name: 'dna-regeneration', cronExpression: '0 2 * * *' };
    mockSchedulerService.updateSchedulerCron.mockResolvedValue(updated);

    const result = await controller.updateCron('dna-regeneration', { cronExpression: '0 2 * * *' });

    expect(mockSchedulerService.updateSchedulerCron).toHaveBeenCalledWith('dna-regeneration', '0 2 * * *');
    expect(result).toEqual(updated);
  });

  it('toggles a dynamic scheduler enabled flag', async () => {
    const updated = { name: 'dna-regeneration', running: false };
    mockSchedulerService.toggleScheduler.mockResolvedValue(updated);

    const result = await controller.toggleScheduler('dna-regeneration', { enabled: false });

    expect(mockSchedulerService.toggleScheduler).toHaveBeenCalledWith('dna-regeneration', false);
    expect(result).toEqual(updated);
  });

  describe('access gate', () => {
    it('is class-gated by @Authorize(["manage","all"]) (GLOBAL_ADMIN only)', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, SchedulerAdminController) as Array<{ action: string; subject: string }> | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'all' }]);
    });
  });
});
