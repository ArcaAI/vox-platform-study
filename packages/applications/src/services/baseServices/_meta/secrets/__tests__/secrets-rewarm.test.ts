// SecretsService warmup re-warm loop tests.
//
// Regression coverage for the production defect where `getSecretSync` consumers
// (TextCompatController / TextProxyController / TtsWsGateway `getForwardHeaders`)
// silently lost their `X-Service-Token` header `SECRETS_TTL_SEC` seconds after
// boot: the warmup set was cached once and never re-warmed, so the cache-only
// sync path went cold on TTL expiry and upstream calls started returning 401.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SecretsService } from '../SecretsService';
import { InMemorySecretsProvider } from '../providers/in-memory-secrets.provider';

const KEY = 'INTERNAL_ACCESS_TOKEN';

describe('SecretsService warmup re-warm loop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps getSecretSync warm past the TTL (the 401-after-boot regression)', async () => {
    vi.useFakeTimers();
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    // TTL 100s, re-warm every 40s → a warmed key is refreshed before it expires.
    const service = new SecretsService(provider, { defaultTtlSec: 100, reWarmIntervalSec: 40 });

    await service.boot({ warmupKeys: [KEY] });
    expect(service.getSecretSync(KEY)).toBe('tok-1');

    // Advance well past the TTL. Without the loop the entry (expiresAt=100s)
    // would be cold; the loop re-warms at 40s/80s/120s so it stays present.
    await vi.advanceTimersByTimeAsync(130_000);
    expect(service.getSecretSync(KEY)).toBe('tok-1');

    service.stopReWarm();
  });

  it('picks up a rotated value on the next re-warm cycle', async () => {
    vi.useFakeTimers();
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    const service = new SecretsService(provider, { defaultTtlSec: 100, reWarmIntervalSec: 40 });
    await service.boot({ warmupKeys: [KEY] });

    // Rotate the underlying value; the loop uses { refresh: true } so it observes it.
    vi.spyOn(provider, 'getSecret').mockResolvedValue('tok-2');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(service.getSecretSync(KEY)).toBe('tok-2');

    service.stopReWarm();
  });

  it('retains the last-good value when a re-warm cycle fails', async () => {
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    const service = new SecretsService(provider, { defaultTtlSec: 100, reWarmIntervalSec: 40 });
    await service.boot({ warmupKeys: [KEY] });
    service.stopReWarm(); // drive the cycle manually

    vi.spyOn(provider, 'getSecret').mockRejectedValue(new Error('vault blip'));
    await expect(service.reWarmWarmupKeys()).resolves.toBeUndefined(); // never throws
    // The sync path keeps serving the last-good token through a transient blip.
    expect(service.getSecretSync(KEY)).toBe('tok-1');
  });

  it('re-fetches a warmup key immediately on invalidation (rotation)', async () => {
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    const service = new SecretsService(provider, { defaultTtlSec: 100 });
    await service.boot({ warmupKeys: [KEY] });
    service.stopReWarm();

    const spy = vi.spyOn(provider, 'getSecret').mockResolvedValue('tok-2');
    service.invalidate(KEY);
    // The re-fetch is fire-and-forget; let its microtask settle.
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(service.getSecretSync(KEY)).toBe('tok-2');
  });

  it('onModuleDestroy stops the loop (no further provider reads)', async () => {
    vi.useFakeTimers();
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    const service = new SecretsService(provider, { defaultTtlSec: 100, reWarmIntervalSec: 40 });
    await service.boot({ warmupKeys: [KEY] });

    const spy = vi.spyOn(provider, 'getSecret');
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not start a loop when caching is disabled (ttl<=0)', async () => {
    vi.useFakeTimers();
    const provider = new InMemorySecretsProvider({ [KEY]: 'tok-1' });
    const service = new SecretsService(provider, { defaultTtlSec: 0 });
    await service.boot({ warmupKeys: [KEY] });

    const spy = vi.spyOn(provider, 'getSecret');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(spy).not.toHaveBeenCalled(); // no interval scheduled
    service.stopReWarm();
  });
});
