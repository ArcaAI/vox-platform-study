/**
 * DepartmentAgentController unit tests (TASK-546).
 *
 * Verifies the class-level `@CanManage('DepartmentAgent')` authorization
 * metadata (the deny-by-default boot audit relies on it), the OCC If-Match
 * requirement on PATCH, and that each route delegates to the service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { DepartmentAgentController } from '../department-agent.controller';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators';

const createMockService = () => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
  setDefault: vi.fn(),
  pin: vi.fn(),
  clone: vi.fn(),
});

describe('DepartmentAgentController — authorization metadata', () => {
  it('is gated class-level on manage:DepartmentAgent (dedicated subject, M-12)', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, DepartmentAgentController);
    expect(meta).toEqual([{ action: 'manage', subject: 'DepartmentAgent' }]);
  });

  it('update requires If-Match (OCC)', () => {
    const meta = Reflect.getMetadata(REQUIRES_IF_MATCH_KEY, (DepartmentAgentController.prototype as never as Record<string, unknown>).update as object);
    expect(meta).toBeTruthy();
  });
});

describe('DepartmentAgentController — delegation', () => {
  let service: ReturnType<typeof createMockService>;
  let controller: DepartmentAgentController;

  beforeEach(() => {
    service = createMockService();
    controller = new DepartmentAgentController(service as never);
  });

  it('list forwards the query + departmentId', async () => {
    service.list.mockResolvedValue({ data: [] });
    await controller.list({ page: 0, limit: 10 } as never, 'dept-1');
    expect(service.list).toHaveBeenCalledWith({ page: 0, limit: 10 }, 'dept-1');
  });

  it('update folds the If-Match header value over expectedVersion', async () => {
    service.update.mockResolvedValue({});
    await controller.update('a-1', { name: 'x', expectedVersion: 1 } as never, 5);
    expect(service.update).toHaveBeenCalledWith('a-1', { name: 'x', expectedVersion: 5 });
  });

  it('pin forwards versionNumber (including null)', async () => {
    service.pin.mockResolvedValue({});
    await controller.pin('a-1', { versionNumber: null } as never);
    expect(service.pin).toHaveBeenCalledWith('a-1', null);
  });

  it('set-default delegates to the service', async () => {
    service.setDefault.mockResolvedValue({});
    await controller.setDefault('a-1');
    expect(service.setDefault).toHaveBeenCalledWith('a-1');
  });

  it('clone forwards the name + slug to the service', async () => {
    service.clone.mockResolvedValue({});
    await controller.clone('a-1', { name: 'My Copy', slug: 'my-copy' } as never);
    expect(service.clone).toHaveBeenCalledWith('a-1', { name: 'My Copy', slug: 'my-copy' });
  });
});
