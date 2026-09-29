import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (repos: { aiModelRepository?: unknown; aiProviderConnectionRepository?: unknown }) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(AiRoutingPolicyService.prototype) as Record<string, unknown>;
  Object.assign(service, repos, { logger });
  return { service: service as unknown as Internals, logger };
};

describe('AiRoutingPolicyService catalogue lookups', () => {
  it('a slug with no row in either tier resolves to null, silently', async () => {
    const findBySlug = vi.fn().mockRejectedValue(new DataNotFoundException('AiModel', 'slug'));
    const { service, logger } = build({ aiModelRepository: { findBySlug } });

    await expect(service.resolveModelBySlugForTenant('slug', 'tenant-1')).resolves.toBeNull();
    expect(findBySlug).toHaveBeenCalledTimes(2);
    expect(findBySlug).toHaveBeenLastCalledWith(SYSTEM_TENANT_ID, 'slug');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('an outage on the tenant tier is logged and rethrown, never falling through to SYSTEM', async () => {
    const outage = new Error('ECONNRESET');
    const findBySlug = vi.fn().mockRejectedValue(outage);
    const { service, logger } = build({ aiModelRepository: { findBySlug } });

    await expect(service.resolveModelBySlugForTenant('slug', 'tenant-1')).rejects.toBe(outage);
    expect(findBySlug).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, modelSlug: 'slug', tenantId: 'tenant-1' }));
  });

  it('resolveRefs leaves a dangling reference unresolved but surfaces an outage', async () => {
    const outage = new Error('ECONNRESET');
    const row = { providerConnectionId: 'c1', modelId: 'm1' };

    const missing = build({
      aiProviderConnectionRepository: { findById: vi.fn().mockRejectedValue(new DataNotFoundException('AiProviderConnection', 'c1')) },
      aiModelRepository: { findById: vi.fn().mockRejectedValue(new DataNotFoundException('AiModel', 'm1')) },
    });
    await expect(missing.service.resolveRefs(row)).resolves.toEqual({ connectionProvider: null, connectionService: null, modelSlug: null });

    const down = build({
      aiProviderConnectionRepository: { findById: vi.fn().mockRejectedValue(outage) },
      aiModelRepository: { findById: vi.fn() },
    });
    await expect(down.service.resolveRefs(row)).rejects.toBe(outage);
    expect(down.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, providerConnectionId: 'c1' }));
  });
});
