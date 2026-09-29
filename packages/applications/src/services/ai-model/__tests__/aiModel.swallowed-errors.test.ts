import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AiModelService } from '../aiModel.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (tenantRepository: unknown) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(AiModelService.prototype) as Record<string, unknown>;
  Object.assign(service, { tenantRepository, logger });
  return { service: service as unknown as Internals, logger };
};

describe('AiModelService.modelTierFor (documented: an unresolvable plan gets the full catalogue)', () => {
  it('a tenant that cannot be found takes the default tier silently', async () => {
    const { service, logger } = build({ findById: vi.fn().mockRejectedValue(new DataNotFoundException('Tenant', 't1')) });

    await expect(service.modelTierFor('tenant-1')).resolves.toBeDefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an outage takes the same default but leaves a warn — the widened tier is at least visible', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build({ findById: vi.fn().mockRejectedValue(outage) });

    await expect(service.modelTierFor('tenant-1')).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: outage, tenantId: 'tenant-1' }));
  });
});
