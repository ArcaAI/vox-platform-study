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

  describe('getSecretSync (cache-only)', () => {
    it('returns the cached value when warm', async () => {
      await service.getSecret('FOO');
      expect(service.getSecretSync('FOO')).toBe('bar');
    });

    it('returns undefined for a cold key (does NOT hit the provider)', () => {
      const spy = vi.spyOn(provider, 'getSecret');
      expect(service.getSecretSync('FOO')).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns undefined when the TTL has expired', async () => {
      const shortLived = new SecretsService(provider, { defaultTtlSec: 0, lruMax: 50 });
      await shortLived.getSecret('FOO');
      expect(shortLived.getSecretSync('FOO')).toBeUndefined();
    });

    it('returns undefined after invalidate(key)', async () => {
      await service.getSecret('FOO');
      service.invalidate('FOO');
      expect(service.getSecretSync('FOO')).toBeUndefined();
    });
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

  it('health() proxies to the provider and reports degraded=false by default', async () => {
    const h = await service.health();
    expect(h).toEqual({ ok: true, latencyMs: 0, provider: 'in-memory', degraded: false });
  });
});

describe('SecretsService.boot()', () => {
  it('calls provider.boot() if defined', async () => {
    const provider = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'v' });
    let bootCalled = false;
    (provider as unknown as { boot: () => Promise<void> }).boot = async () => {
      bootCalled = true;
    };
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    await service.boot();
    expect(bootCalled).toBe(true);
  });

  it('skips boot delegation when provider does not implement boot', async () => {
    const provider = new InMemorySecretsProvider({ K: 'v' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    await expect(service.boot()).resolves.toBeUndefined();
  });

  it('warms up the cache so first read does not hit the provider', async () => {
    const provider = new InMemorySecretsProvider({
      JWT_SECRET_KEY: 'jwt',
      SESSION_SECRET_KEY: 'ses',
    });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    await service.boot({ warmupKeys: ['JWT_SECRET_KEY', 'SESSION_SECRET_KEY'] });
    const spy = vi.spyOn(provider, 'getSecret');
    await service.getSecret('JWT_SECRET_KEY');
    await service.getSecret('SESSION_SECRET_KEY');
    expect(spy).not.toHaveBeenCalled();
  });

  it('boot() does not fail when a warmup key is missing from the provider', async () => {
    const provider = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'v' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    await expect(
      service.boot({ warmupKeys: ['JWT_SECRET_KEY', 'NOPE'] }),
    ).resolves.toBeUndefined();
  });
});

describe('SecretsService.encrypt/decrypt (Phase 4 Task 4.5)', () => {
  it('throws a guard error when the underlying provider has no encrypt()', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    await expect(service.encrypt(Buffer.from('x'))).rejects.toThrow(/requires vault/i);
  });

  it('supportsTransit() is false when the provider has no encrypt() (env / non-vault)', () => {
    const service = new SecretsService(new InMemorySecretsProvider({}), {});
    expect(service.supportsTransit()).toBe(false);
  });

  it('supportsTransit() is true when the provider exposes encrypt() (vault)', () => {
    const fakeVault = {
      encrypt: vi.fn(),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    expect(service.supportsTransit()).toBe(true);
  });

  it('throws a guard error when the underlying provider has no decrypt()', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    await expect(service.decrypt('vault:v1:cccc')).rejects.toThrow(/requires vault/i);
  });

  it('delegates encrypt() to the Vault provider when one is wired in', async () => {
    // Structural fake — anything with .encrypt + .getSecret + .health
    // satisfies the SecretsService's expectations.
    const fakeVault = {
      encrypt: vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const ct = await service.encrypt(Buffer.from('hello'));
    expect(ct).toBe('vault:v1:aGVsbG8=');
    expect((fakeVault as unknown as { encrypt: unknown }).encrypt).toHaveBeenCalledTimes(1);
  });

  it('delegates decrypt() to the Vault provider when one is wired in', async () => {
    const fakeVault = {
      decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const pt = await service.decrypt('vault:v1:aGVsbG8=');
    expect(pt.toString('utf8')).toBe('hello');
    expect((fakeVault as unknown as { decrypt: unknown }).decrypt).toHaveBeenCalledTimes(1);
  });

  it('does not leak the plaintext or ciphertext into the guard error message', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    const verySecret = 'super-secret-plaintext-DO-NOT-LEAK';
    const veryCiphertext = 'vault:v1:DEAD-BEEF-CIPHER-DO-NOT-LEAK';
    try {
      await service.encrypt(Buffer.from(verySecret));
    } catch (e) {
      expect((e as Error).message).not.toContain(verySecret);
    }
    try {
      await service.decrypt(veryCiphertext);
    } catch (e) {
      expect((e as Error).message).not.toContain(veryCiphertext);
    }
  });
});

describe('SecretsService keyed encrypt/decrypt (Phase 3A PHI)', () => {
  it('forwards an explicit key name to the provider on encrypt', async () => {
    const fakeVault = {
      encrypt: vi.fn(async (b: Buffer, key?: string) => `vault:v1:${key}:${b.toString('base64')}`),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const ct = await service.encrypt(Buffer.from('hello'), 'hope-phi');
    expect(ct).toBe('vault:v1:hope-phi:aGVsbG8=');
    expect((fakeVault as unknown as { encrypt: ReturnType<typeof vi.fn> }).encrypt).toHaveBeenCalledWith(
      Buffer.from('hello'),
      'hope-phi',
    );
  });

  it('forwards an explicit key name to the provider on decrypt', async () => {
    const fakeVault = {
      decrypt: vi.fn(async (ct: string, _key?: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const pt = await service.decrypt('vault:v1:aGVsbG8=', 'hope-phi');
    expect(pt.toString('utf8')).toBe('hello');
    expect((fakeVault as unknown as { decrypt: ReturnType<typeof vi.fn> }).decrypt).toHaveBeenCalledWith(
      'vault:v1:aGVsbG8=',
      'hope-phi',
    );
  });

  it('getPhiTransitKeyName returns the provider PHI key when exposed', () => {
    const fakeVault = {
      phiTransitKey: 'hope-phi-prod',
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    expect(service.getPhiTransitKeyName()).toBe('hope-phi-prod');
  });

  it('getPhiTransitKeyName defaults to "hope-phi" when the provider has no Transit support', () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    expect(service.getPhiTransitKeyName()).toBe('hope-phi');
  });
});

describe('SecretsService lease-renewer integration (Phase 5 Task 5.7)', () => {
  it('reports degraded=false on health when no renewer is registered', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    const h = await service.health();
    expect(h.degraded).toBe(false);
  });

  it('reports degraded=true on health when a registered renewer is degraded', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    service.setLeaseRenewer({
      get degraded() {
        return true;
      },
      get failureCount() {
        return 3;
      },
    });
    const h = await service.health();
    expect(h.degraded).toBe(true);
    expect(h.detail).toMatch(/lease.*renew/i);
  });

  it('does not downgrade ok=true when only the renewer is degraded (stale-while-revalidate)', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    service.setLeaseRenewer({
      get degraded() {
        return true;
      },
      get failureCount() {
        return 3;
      },
    });
    const h = await service.health();
    expect(h.ok).toBe(true);
    expect(h.degraded).toBe(true);
  });

  it('clearLeaseRenewer() removes the registered renewer', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    service.setLeaseRenewer({
      get degraded() {
        return true;
      },
      get failureCount() {
        return 3;
      },
    });
    service.clearLeaseRenewer();
    const h = await service.health();
    expect(h.degraded).toBe(false);
  });
});

describe('SecretsService.requestDbCredential (Phase 5 Task 5.3)', () => {
  it('throws a guard error when the underlying provider has no issueDbCredential()', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    await expect(service.requestDbCredential('hope-app-role')).rejects.toThrow(/requires vault/i);
  });

  it('proxies to provider.issueDbCredential when wired to a Vault provider', async () => {
    const fakeVault = {
      issueDbCredential: vi.fn(async (role: string) => ({
        username: `v-token-${role}-1`,
        password: 'pw-redacted',
        leaseId: `database/creds/${role}/abc`,
        ttlSec: 3600,
      })),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const cred = await service.requestDbCredential('hope-app-role');
    expect(cred.username).toBe('v-token-hope-app-role-1');
    expect(cred.leaseId).toBe('database/creds/hope-app-role/abc');
    expect(cred.ttlSec).toBe(3600);
    expect(
      (fakeVault as unknown as { issueDbCredential: unknown }).issueDbCredential,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not cache the issued credential (returns a fresh credential each call)', async () => {
    let counter = 0;
    const fakeVault = {
      issueDbCredential: vi.fn(async (role: string) => {
        counter += 1;
        return {
          username: `v-token-${role}-${counter}`,
          password: `pw-${counter}`,
          leaseId: `database/creds/${role}/${counter}`,
          ttlSec: 3600,
        };
      }),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const a = await service.requestDbCredential('hope-app-role');
    const b = await service.requestDbCredential('hope-app-role');
    expect(a.username).not.toBe(b.username);
    expect(a.leaseId).not.toBe(b.leaseId);
  });

  it('does not leak the role name or password into the guard error message', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    try {
      await service.requestDbCredential('hope-app-role');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg.toLowerCase()).toContain('vault');
      expect(msg).not.toContain('hope-app-role');
    }
  });
});

// BUG-006 — renewDbLease is the missing link between issueDbCredential
// (one-shot) and VaultLeaseRenewer (periodic caller): without it the
// renewer has nothing to invoke and dynamic PG creds go stale at lease
// expiry. Mirrors the requestDbCredential capability-check pattern above.
describe('SecretsService.renewDbLease (BUG-006)', () => {
  it('throws a guard error when the underlying provider has no renewDbLease()', async () => {
    const provider = new InMemorySecretsProvider({});
    const service = new SecretsService(provider, {});
    await expect(service.renewDbLease('lease-1', 3600)).rejects.toThrow(/requires vault/i);
  });

  it('proxies to provider.renewDbLease with the lease id and increment', async () => {
    const fakeVault = {
      renewDbLease: vi.fn(async (_leaseId: string, _incrementSec: number) => ({ ttlSec: 3600 })),
      getSecret: vi.fn(),
      getSecrets: vi.fn(),
      health: vi.fn(),
    } as unknown as InMemorySecretsProvider;
    const service = new SecretsService(fakeVault, {});
    const result = await service.renewDbLease('database/creds/hope-app-role/abc', 3600);
    expect(result).toEqual({ ttlSec: 3600 });
    expect(
      (fakeVault as unknown as { renewDbLease: unknown }).renewDbLease,
    ).toHaveBeenCalledWith('database/creds/hope-app-role/abc', 3600);
  });
});

describe('SecretsService Redis Pub/Sub invalidation', () => {
  it('clears one key on "arca:secrets:invalidate" message {key}', async () => {
    const provider = new InMemorySecretsProvider({ K: 'v', K2: 'v2' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    // Minimal Redis-subscriber stub: capture handler and let us emit.
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sub = {
      subscribe: vi.fn((_ch: string, cb: (err: Error | null, c: number) => void) => cb(null, 1)),
      on: (event: string, h: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(h);
      },
    };
    service.attachRedisSubscriber(sub as never);

    await service.getSecret('K');
    await service.getSecret('K2');
    const spy = vi.spyOn(provider, 'getSecret');

    handlers.message?.forEach((h) =>
      h('arca:secrets:invalidate', JSON.stringify({ key: 'K' })),
    );

    await service.getSecret('K');
    await service.getSecret('K2');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('K', undefined);
  });

  it('clears the whole cache on {all:true}', async () => {
    const provider = new InMemorySecretsProvider({ K: 'v', K2: 'v2' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sub = {
      subscribe: vi.fn((_ch: string, cb: (err: Error | null, c: number) => void) => cb(null, 1)),
      on: (event: string, h: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(h);
      },
    };
    service.attachRedisSubscriber(sub as never);

    await service.getSecret('K');
    await service.getSecret('K2');
    const spy = vi.spyOn(provider, 'getSecret');
    handlers.message?.forEach((h) =>
      h('arca:secrets:invalidate', JSON.stringify({ all: true })),
    );

    await service.getSecret('K');
    await service.getSecret('K2');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ignores messages on other channels', async () => {
    const provider = new InMemorySecretsProvider({ K: 'v' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sub = {
      subscribe: vi.fn((_ch: string, cb: (err: Error | null, c: number) => void) => cb(null, 1)),
      on: (event: string, h: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(h);
      },
    };
    service.attachRedisSubscriber(sub as never);

    await service.getSecret('K');
    const spy = vi.spyOn(provider, 'getSecret');
    handlers.message?.forEach((h) =>
      h('other:channel', JSON.stringify({ all: true })),
    );

    await service.getSecret('K');
    expect(spy).not.toHaveBeenCalled();
  });

  it('tolerates a malformed JSON payload (no crash, no eviction)', async () => {
    const provider = new InMemorySecretsProvider({ K: 'v' });
    const service = new SecretsService(provider, { defaultTtlSec: 300 });
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sub = {
      subscribe: vi.fn((_ch: string, cb: (err: Error | null, c: number) => void) => cb(null, 1)),
      on: (event: string, h: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(h);
      },
    };
    service.attachRedisSubscriber(sub as never);

    await service.getSecret('K');
    const spy = vi.spyOn(provider, 'getSecret');
    expect(() =>
      handlers.message?.forEach((h) => h('arca:secrets:invalidate', '{not-json')),
    ).not.toThrow();
    await service.getSecret('K');
    expect(spy).not.toHaveBeenCalled();
  });
});
