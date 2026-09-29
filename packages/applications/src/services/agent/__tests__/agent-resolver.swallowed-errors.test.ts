import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AgentResolverService, ConnectionIdentityLookup } from '../agent-resolver.service';
import { TtsAgentResolverService } from '../tts-agent-resolver.service';

const makeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const resolver = (aiModelRepository: unknown) => {
  const logger = makeLogger();
  const service = Object.create(AgentResolverService.prototype) as Record<string, unknown>;
  service.aiModelRepository = aiModelRepository;
  service.logger = logger;
  return { service: service as unknown as Internals, logger };
};

describe('AgentResolverService model lookups', () => {
  it('a model that does not exist is "no model", silently', async () => {
    const { service, logger } = resolver({ findById: vi.fn().mockRejectedValue(new DataNotFoundException('AiModel', 'm1')) });

    await expect(service.modelById('m1', 'tenant-1')).resolves.toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a database outage is logged with the ids and rethrown — it must not read as "no model"', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = resolver({ findById: vi.fn().mockRejectedValue(outage) });

    await expect(service.modelById('m1', 'tenant-1')).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, modelId: 'm1', tenantId: 'tenant-1' }));
  });

  it('the by-slug cascade falls through to SYSTEM on a miss, and stops on an outage', async () => {
    const outage = new Error('ECONNRESET');
    const findBySlug = vi
      .fn()
      .mockRejectedValueOnce(new DataNotFoundException('AiModel', 'slug'))
      .mockResolvedValueOnce({ id: 'system-model' })
      .mockRejectedValueOnce(outage);
    const { service } = resolver({ findBySlug });

    await expect(service.modelBySlug('slug', 'tenant-1')).resolves.toEqual({ id: 'system-model' });
    expect(findBySlug).toHaveBeenNthCalledWith(2, SYSTEM_TENANT_ID, 'slug');
    await expect(service.modelBySlug('slug', 'tenant-1')).rejects.toBe(outage);
  });
});

describe('ConnectionIdentityLookup', () => {
  it('degrades to the naming convention on a listing outage but leaves a warn', async () => {
    const outage = new Error('list failed');
    const lookup = new ConnectionIdentityLookup({ list: vi.fn().mockRejectedValue(outage) }, 'stt' as never, 'tenant-1');
    const logger = makeLogger();
    (lookup as unknown as { logger: typeof logger }).logger = logger;

    await expect(lookup.siblings('openai')).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: outage, tenantId: 'tenant-1' }));
  });
});

describe('TtsAgentResolverService.metaDataFor', () => {
  const build = (findBySlug: ReturnType<typeof vi.fn>) => {
    const logger = makeLogger();
    const service = Object.create(TtsAgentResolverService.prototype) as Record<string, unknown>;
    service.aiModelRepository = { findBySlug };
    service.logger = logger;
    return { service: service as unknown as Internals, logger };
  };

  it('a model with no row anywhere has null metadata', async () => {
    const { service, logger } = build(vi.fn().mockRejectedValue(new DataNotFoundException('AiModel', 'kokoro')));

    await expect(service.metaDataFor({ slug: 'kokoro' }, 'tenant-1')).resolves.toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('an outage is logged and rethrown instead of silently producing a spec without voices', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build(vi.fn().mockRejectedValue(outage));

    await expect(service.metaDataFor({ slug: 'kokoro' }, 'tenant-1')).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, modelSlug: 'kokoro' }));
  });
});
