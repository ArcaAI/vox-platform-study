/**
 * NotificationController unit tests.
 *
 * Read/update/delete plane over the system-emitted notifications — there is
 * deliberately NO admin POST (notifications are emitted by the platform, not
 * authored). CASL enforcement is guard-side; these specs pin the metadata and
 * the delegation/projection contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { NotificationController } from '../notification.controller';

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'ntf-1',
  tenantId: 't1',
  title: 'Job finished',
  message: 'done',
  data: null,
  type: 'INFO',
  read: false,
  resourceSubscriptionId: null,
  targetUserId: 'user-1',
  resourceStatus: 'ENABLED',
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  version: 1,
  ...overrides,
});

function makeController() {
  const notificationService = {
    fetchAll: vi.fn().mockResolvedValue({ data: [entity()], count: 1, page: 1, limit: 20 }),
    fetchAllByTenantId: vi.fn().mockResolvedValue({ data: [entity()], count: 1, page: 1, limit: 20 }),
    fetchById: vi.fn().mockResolvedValue(entity()),
    update: vi.fn().mockResolvedValue(entity({ read: true })),
    deleteById: vi.fn().mockResolvedValue(entity({ resourceStatus: 'DELETED' })),
  };
  const controller = new NotificationController(notificationService as never);
  return { controller, notificationService };
}

describe('NotificationController — authorization metadata', () => {
  it('mounts at admin/notifications behind class-level manage:Notification', () => {
    expect(Reflect.getMetadata(PATH_METADATA, NotificationController)).toBe('admin/notifications');
    expect(Reflect.getMetadata('required_permissions', NotificationController)).toEqual([{ action: 'manage', subject: 'Notification' }]);
  });

  it('exposes no create route (notifications are system-emitted)', () => {
    expect((NotificationController.prototype as unknown as Record<string, unknown>).create).toBeUndefined();
  });
});

describe('NotificationController — delegation + projection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetchAll delegates to the tenant-scoped list', async () => {
    const { controller, notificationService } = makeController();
    const result = await controller.fetchAll({ page: 1, limit: 20 } as never);
    expect(notificationService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ sort: 'createdAt:desc' }));
    expect(result.data[0]).toMatchObject({ id: 'ntf-1', title: 'Job finished' });
  });

  it('fetchAll routes ?tenantId= through fetchAllByTenantId', async () => {
    const { controller, notificationService } = makeController();
    await controller.fetchAll({ tenantId: 't9' } as never);
    expect(notificationService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't9' }));
    expect(notificationService.fetchAll).not.toHaveBeenCalled();
  });

  it('fetchById delegates and maps', async () => {
    const { controller, notificationService } = makeController();
    const result = await controller.fetchById('ntf-1');
    expect(notificationService.fetchById).toHaveBeenCalledWith('ntf-1');
    expect(result).toMatchObject({ id: 'ntf-1' });
  });

  it('update delegates the sparse patch (no OCC — service uses a plain update)', async () => {
    const { controller, notificationService } = makeController();
    const result = await controller.update('ntf-1', { read: true } as never);
    expect(notificationService.update).toHaveBeenCalledWith('ntf-1', { read: true });
    expect(result).toMatchObject({ read: true });
  });

  it('delete delegates to the soft delete', async () => {
    const { controller, notificationService } = makeController();
    await controller.delete('ntf-1');
    expect(notificationService.deleteById).toHaveBeenCalledWith('ntf-1');
  });
});
