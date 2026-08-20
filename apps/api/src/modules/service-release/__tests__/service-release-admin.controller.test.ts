/**
 * ServiceReleaseAdminController unit tests.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceReleaseAdminController } from '../service-release-admin.controller';

const createMockService = () => ({
  registerInstance: vi.fn(),
  attachDigest: vi.fn(),
  listReleases: vi.fn(),
  listCurrent: vi.fn(),
  getHistory: vi.fn(),
});

describe('ServiceReleaseAdminController', () => {
  it('delegates list() to listReleases with the query as-is', async () => {
    const service = createMockService();
    const response = { count: 1, limit: 25, page: 1, data: [] };
    service.listReleases.mockResolvedValue(response);

    const controller = new ServiceReleaseAdminController(service as any);
    const query = { serviceName: 'text', environment: 'dev', page: 1, limit: 25 };
    const result = await controller.list(query as any);

    expect(service.listReleases).toHaveBeenCalledWith(query);
    expect(result).toBe(response);
  });

  it('delegates current() to listCurrent with the environment query param', async () => {
    const service = createMockService();
    const response = [{ serviceName: 'text', environment: 'dev' }];
    service.listCurrent.mockResolvedValue(response);

    const controller = new ServiceReleaseAdminController(service as any);
    const result = await controller.current('dev');

    expect(service.listCurrent).toHaveBeenCalledWith('dev');
    expect(result).toBe(response);
  });

  it('delegates history() to getHistory with the path param', async () => {
    const service = createMockService();
    const response = [{ id: 'release-1', serviceName: 'text' }];
    service.getHistory.mockResolvedValue(response);

    const controller = new ServiceReleaseAdminController(service as any);
    const result = await controller.history('text');

    expect(service.getHistory).toHaveBeenCalledWith('text');
    expect(result).toBe(response);
  });

  it('propagates a rejection from getHistory (unknown service → 404 via the global filter)', async () => {
    const service = createMockService();
    service.getHistory.mockRejectedValue(new Error('not found'));

    const controller = new ServiceReleaseAdminController(service as any);

    await expect(controller.history('unknown-service')).rejects.toThrow('not found');
  });
});
