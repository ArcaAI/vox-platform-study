/**
 * ResourceSubscriptionController unit tests.
 *
 * CRUD + toggle plane over ResourceSubscriptionService. CASL enforcement is
 * guard-side; these specs pin the metadata and delegation/projection contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ResourceSubscriptionController } from '../resource-subscription.controller';

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  tenantId: 't1',
  resourceId: 'res-1',
  resourceTypeName: 'Consultation',
  subscriptionType: 'WATCH',
  targetUserId: 'user-1',
  subscriptionMetadata: null,
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
  const resourceSubscriptionService = {
    create: vi.fn().mockResolvedValue(entity()),
    fetchAll: vi.fn().mockResolvedValue({ data: [entity()], count: 1, page: 1, limit: 20 }),
    fetchById: vi.fn().mockResolvedValue(entity()),
    update: vi.fn().mockResolvedValue(entity()),
    toggleSubscriptionById: vi.fn().mockResolvedValue(entity({ resourceStatus: 'DISABLED' })),
    deleteById: vi.fn().mockResolvedValue(entity({ resourceStatus: 'DELETED' })),
  };
  const controller = new ResourceSubscriptionController(resourceSubscriptionService as never);
  return { controller, resourceSubscriptionService };
}

describe('ResourceSubscriptionController — authorization metadata', () => {
  it('mounts at admin/resource-subscriptions behind class-level manage:ResourceSubscription', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ResourceSubscriptionController)).toBe('admin/resource-subscriptions');
    expect(Reflect.getMetadata('required_permissions', ResourceSubscriptionController)).toEqual([
      { action: 'manage', subject: 'ResourceSubscription' },
    ]);
  });

  it('declares the toggle route as POST :id/toggle', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ResourceSubscriptionController.prototype.toggle)).toBe(':id/toggle');
    expect(Reflect.getMetadata(METHOD_METADATA, ResourceSubscriptionController.prototype.toggle)).toBe(RequestMethod.POST);
  });
});

describe('ResourceSubscriptionController — delegation + projection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetchAll delegates the paginated query', async () => {
    const { controller, resourceSubscriptionService } = makeController();
    const result = await controller.fetchAll({ page: 1, limit: 20 } as never);
    expect(resourceSubscriptionService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ sort: 'createdAt:desc' }));
    expect(result.data[0]).toMatchObject({ id: 'sub-1', targetUserId: 'user-1' });
  });

  it('create delegates and maps', async () => {
    const { controller, resourceSubscriptionService } = makeController();
    const request = { subscriptionType: 'WATCH', targetUserId: 'user-1' };
    const result = await controller.create(request as never);
    expect(resourceSubscriptionService.create).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ id: 'sub-1' });
  });

  it('update delegates the sparse patch', async () => {
    const { controller, resourceSubscriptionService } = makeController();
    await controller.update('sub-1', { subscriptionType: 'MUTE' } as never);
    expect(resourceSubscriptionService.update).toHaveBeenCalledWith('sub-1', { subscriptionType: 'MUTE' });
  });

  it('toggle delegates to toggleSubscriptionById', async () => {
    const { controller, resourceSubscriptionService } = makeController();
    const result = await controller.toggle('sub-1');
    expect(resourceSubscriptionService.toggleSubscriptionById).toHaveBeenCalledWith('sub-1');
    expect(result).toMatchObject({ resourceStatus: 'DISABLED' });
  });

  it('delete delegates to the soft delete', async () => {
    const { controller, resourceSubscriptionService } = makeController();
    await controller.delete('sub-1');
    expect(resourceSubscriptionService.deleteById).toHaveBeenCalledWith('sub-1');
  });
});
