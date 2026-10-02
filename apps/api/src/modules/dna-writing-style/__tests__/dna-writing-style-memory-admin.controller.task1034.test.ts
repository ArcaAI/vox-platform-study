/**
 * TASK-1034 §4b — the six admin DNA memory / schedule routes: thin delegation to
 * `DnaMemoryAdminService`, API keys forbidden, `read`/`manage:DnaWritingStyleReport`.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { DnaWritingStyleMemoryAdminController } from '../dna-writing-style-memory-admin.controller';

const svc = {
  getMemorySummary: vi.fn().mockResolvedValue([]),
  listMemory: vi.fn().mockResolvedValue({ data: [], count: 0, page: 1, limit: 20 }),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  getSchedule: vi.fn().mockResolvedValue({ enabled: true }),
  updateSchedule: vi.fn().mockResolvedValue({ enabled: false }),
  runNow: vi.fn().mockResolvedValue({ queued: 0 }),
};
const controller = new DnaWritingStyleMemoryAdminController(svc as never);
const C = DnaWritingStyleMemoryAdminController;
const perms = (method: keyof DnaWritingStyleMemoryAdminController) =>
  Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, C.prototype[method]) ?? Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, C);

describe('DnaWritingStyleMemoryAdminController', () => {
  it('forbids API keys at the class level', () => {
    expect(Reflect.getMetadata(API_KEY_FORBIDDEN, C)).toBe(true);
    expect(Reflect.getMetadata('path', C)).toBe('admin/dna-writing-styles');
  });

  it('reads need read:, writes need manage:DnaWritingStyleReport', () => {
    expect(perms('getMemorySummary')).toEqual([{ action: 'read', subject: 'DnaWritingStyleReport' }]);
    expect(perms('listMemory')).toEqual([{ action: 'read', subject: 'DnaWritingStyleReport' }]);
    expect(perms('getSchedule')).toEqual([{ action: 'read', subject: 'DnaWritingStyleReport' }]);
    expect(perms('deleteMemory')).toEqual([{ action: 'manage', subject: 'DnaWritingStyleReport' }]);
    expect(perms('updateSchedule')).toEqual([{ action: 'manage', subject: 'DnaWritingStyleReport' }]);
    expect(perms('runSchedule')).toEqual([{ action: 'manage', subject: 'DnaWritingStyleReport' }]);
  });

  it('delegates every route to the service', async () => {
    await controller.getMemorySummary();
    await controller.listMemory({ doctorId: 'd', page: 2 });
    await controller.deleteMemory('s-1');
    await controller.getSchedule();
    await controller.updateSchedule({ enabled: false });
    await controller.runSchedule();
    expect(svc.getMemorySummary).toHaveBeenCalled();
    expect(svc.listMemory).toHaveBeenCalledWith({ doctorId: 'd', page: 2 });
    expect(svc.deleteMemory).toHaveBeenCalledWith('s-1');
    expect(svc.updateSchedule).toHaveBeenCalledWith({ enabled: false });
    expect(svc.runNow).toHaveBeenCalled();
  });
});
