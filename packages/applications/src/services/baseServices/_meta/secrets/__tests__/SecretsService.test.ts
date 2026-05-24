// Phase 2C (TASK-302 Stream B) - SecretsService unit tests.
//
// Tests use InMemorySecretsProvider so cache / TTL / invalidation behavior
// can be observed without touching Vault or env.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretsService } from '../SecretsService';
import { InMemorySecretsProvider } from '../providers/in-memory-secrets.provider';

describe('SecretsService (cache + TTL)', () => {
  let provider: InMemorySecretsProvider;
  let service: SecretsService;

  beforeEach(() => {
    provider = new InMemorySecretsProvider({
      FOO: 'bar',
      JWT_SECRET_KEY: 'abc',
      JSON_KEY: '{"x":1}',
    });
    service = new SecretsService(provider, { defaultTtlSec: 300, lruMax: 200 });
  });

  it('returns the value from the provider', async () => {
    await expect(service.getSecret('FOO')).resolves.toBe('bar');
  });

  it('caches subsequent reads (provider called once)', async () => {
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('FOO');
    await service.getSecret('FOO');
    await service.getSecret('FOO');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refresh:true bypasses the cache', async () => {
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('FOO');
    await service.getSecret('FOO', { refresh: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidate(key) clears that key from cache', async () => {
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('FOO');
    service.invalidate('FOO');
    await service.getSecret('FOO');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidateAll() clears the entire cache', async () => {
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('FOO');
    await service.getSecret('JWT_SECRET_KEY');
    service.invalidateAll();
    await service.getSecret('FOO');
    await service.getSecret('JWT_SECRET_KEY');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('honors TTL expiry per call (ttlSec=0 -> always refetch)', async () => {
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('FOO', { ttlSec: 0 });
    await service.getSecret('FOO', { ttlSec: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('getSecretOptional returns undefined on missing key', async () => {
    await expect(service.getSecretOptional('NOPE')).resolves.toBeUndefined();
  });

  it('getSecretJson parses JSON', async () => {
    await expect(service.getSecretJson<{ x: number }>('JSON_KEY')).resolves.toEqual({ x: 1 });
  });

  it('getSecrets bulk reads + caches', async () => {
    const spy = vi.spyOn(provider, 'getSecrets');
    const out = await service.getSecrets(['FOO', 'JWT_SECRET_KEY']);
    expect(out).toEqual({ FOO: 'bar', JWT_SECRET_KEY: 'abc' });
    // Second call should hit cache for both keys (no provider call).
    spy.mockClear();
    const out2 = await service.getSecrets(['FOO', 'JWT_SECRET_KEY']);
    expect(out2).toEqual({ FOO: 'bar', JWT_SECRET_KEY: 'abc' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('health() proxies to the provider', async () => {
    const h = await service.health();
    expect(h).toEqual({ ok: true, latencyMs: 0, provider: 'in-memory' });
  });
});
