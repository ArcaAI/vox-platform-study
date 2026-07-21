/**
 * WebhookController unit tests.
 *
 * CASL enforcement runs in the global UnifiedAuthGuard (e2e-covered); these
 * specs pin the controller's OWN contract: the `@Authorize` metadata tuples,
 * service delegation (list branching on `?tenantId=`), the DTO projection at
 * the edge, and the If-Match → `expectedVersion` fold on the OCC PATCH.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WebhookController } from '../webhook.controller';

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'wh-1',
  tenantId: 't1',
  name: 'hook',
  url: 'https://example.com/hook',
  hashedSecret: null,
  resourceTypeName: 'Consultation',
  resourceId: null,
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
  const webhookService = {
    create: vi.fn().mockResolvedValue(entity()),
    fetchAll: vi.fn().mockResolvedValue({ data: [entity()], count: 1, page: 1, limit: 20 }),
    fetchAllByTenantId: vi.fn().mockResolvedValue({ data: [entity()], count: 1, page: 1, limit: 20 }),
    fetchById: vi.fn().mockResolvedValue(entity()),
    update: vi.fn().mockResolvedValue(entity({ version: 2 })),
    deleteById: vi.fn().mockResolvedValue(entity({ resourceStatus: 'DELETED' })),
    fetchRunHistory: vi.fn().mockResolvedValue({ data: [], count: 0, page: 1, limit: 20 }),
  };
  const controller = new WebhookController(webhookService as never);
  return { controller, webhookService };
}

describe('WebhookController — authorization metadata', () => {
  it('mounts at admin/webhooks behind class-level manage:Webhook', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebhookController)).toBe('admin/webhooks');
    expect(Reflect.getMetadata('required_permissions', WebhookController)).toEqual([{ action: 'manage', subject: 'Webhook' }]);
  });

  it('pins the delivery log to read:WebhookRunHistory (method-level override)', () => {
    expect(Reflect.getMetadata('required_permissions', WebhookController.prototype.fetchDeliveries)).toEqual([
      { action: 'read', subject: 'WebhookRunHistory' },
    ]);
  });

  it('declares the OCC PATCH route (If-Match required)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebhookController.prototype.update)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, WebhookController.prototype.update)).toBe(RequestMethod.PATCH);
  });
});

describe('WebhookController — delegation + projection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetchAll delegates to the tenant-scoped list and maps to the paginated DTO', async () => {
    const { controller, webhookService } = makeController();
    const result = await controller.fetchAll({ page: 1, limit: 20 } as never);
    expect(webhookService.fetchAll).toHaveBeenCalledWith(expect.objectContaining({ sort: 'updatedAt:desc' }));
    expect(result.count).toBe(1);
    expect(result.data[0]).toMatchObject({ id: 'wh-1', name: 'hook', version: 1 });
  });

  it('fetchAll routes ?tenantId= through fetchAllByTenantId (service enforces SA-only cross-tenant)', async () => {
    const { controller, webhookService } = makeController();
    await controller.fetchAll({ page: 1, limit: 20, tenantId: 't9' } as never);
    expect(webhookService.fetchAllByTenantId).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't9' }));
    expect(webhookService.fetchAll).not.toHaveBeenCalled();
  });

  it('create delegates and returns the mapped response', async () => {
    const { controller, webhookService } = makeController();
    const request = { name: 'hook', url: 'https://example.com/hook', resourceTypeName: 'Consultation' };
    const result = await controller.create(request as never);
    expect(webhookService.create).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ id: 'wh-1', name: 'hook' });
  });

  it('update folds the If-Match header version over the body expectedVersion', async () => {
    const { controller, webhookService } = makeController();
    await controller.update('wh-1', { name: 'renamed', expectedVersion: 2 } as never, 5);
    expect(webhookService.update).toHaveBeenCalledWith('wh-1', { name: 'renamed', expectedVersion: 5 });
  });

  it('update falls back to the body expectedVersion without the header', async () => {
    const { controller, webhookService } = makeController();
    await controller.update('wh-1', { name: 'renamed', expectedVersion: 2 } as never, undefined);
    expect(webhookService.update).toHaveBeenCalledWith('wh-1', { name: 'renamed', expectedVersion: 2 });
  });

  it('delete delegates to the soft delete', async () => {
    const { controller, webhookService } = makeController();
    await controller.delete('wh-1');
    expect(webhookService.deleteById).toHaveBeenCalledWith('wh-1');
  });

  it('fetchDeliveries returns the paginated delivery log', async () => {
    const { controller, webhookService } = makeController();
    const result = await controller.fetchDeliveries('wh-1', { page: 2, limit: 10 } as never);
    expect(webhookService.fetchRunHistory).toHaveBeenCalledWith('wh-1', expect.objectContaining({ page: 2, limit: 10 }));
    expect(result.count).toBe(0);
  });
});
