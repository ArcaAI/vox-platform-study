import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (tenantRepository: unknown) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(AiModelService.prototype) as Record<string, unknown>;
  Object.assign(service, { tenantRepository, logger });
  return { service: service as unknown as Internals, logger };
};

describe('AiModelService.modelTierFor (fails closed: an unreadable plan never widens the catalogue)', () => {
  it('a tenant that cannot be found is an error, not the full tier', async () => {
    const miss = new DataNotFoundException('Tenant', 't1');
    const { service } = build({ findById: vi.fn().mockRejectedValue(miss) });

    await expect(service.modelTierFor('tenant-1')).rejects.toBe(miss);
  });

  it('an outage propagates instead of granting the full tier', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build({ findById: vi.fn().mockRejectedValue(outage) });

    await expect(service.modelTierFor('tenant-1')).rejects.toBe(outage);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('SYSTEM still reads the full catalogue without a tenant lookup', async () => {
    const findById = vi.fn();
    const { service } = build({ findById });

    await expect(service.modelTierFor(SYSTEM_TENANT_ID)).resolves.toBeDefined();
    expect(findById).not.toHaveBeenCalled();
  });
});
