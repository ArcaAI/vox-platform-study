// VaultSecretsProvider unit tests.
//
// All tests in this file use a mocked node-vault client (assigned via
// `(p as unknown as { client: ... }).client = ...`) so they run with no
// network. The dev-container integration test lives in
// vault-secrets.provider.integration.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VaultSecretsProvider,
  VaultProviderConfig,
} from '../vault-secrets.provider';

/** Helper: build a config with required + transit defaults. */
function cfg(overrides: Partial<VaultProviderConfig> = {}): VaultProviderConfig {
  return {
    addr: 'http://vault:8200',
    roleId: 'rid',
    secretId: 'sid',
    kvMount: 'secret',
    kvPrefix: 'hope',
    transitMount: 'transit',
    transitKey: 'hope-globalsetting',
    ...overrides,
  };
}

describe('VaultSecretsProvider (construction)', () => {
  it('requires VAULT_ADDR', () => {
    expect(
      () =>
        new VaultSecretsProvider({
          addr: '',
          roleId: 'rid',
          secretId: 'sid',
          kvMount: 'secret',
          kvPrefix: 'hope',
          transitMount: 'transit',
          transitKey: 'hope-globalsetting',
        }),
    ).toThrow(/VAULT_ADDR/);
  });

  it('requires VAULT_ROLE_ID', () => {
    expect(
      () =>
        new VaultSecretsProvider({
          addr: 'http://vault:8200',
          roleId: '',
          secretId: 'sid',
          kvMount: 'secret',
          kvPrefix: 'hope',
          transitMount: 'transit',
          transitKey: 'hope-globalsetting',
        }),
    ).toThrow(/VAULT_ROLE_ID/);
  });

  it('requires a wrapped or raw secret_id', () => {
    expect(
      () =>
        new VaultSecretsProvider({
          addr: 'http://vault:8200',
          roleId: 'rid',
          kvMount: 'secret',
          kvPrefix: 'hope',
          transitMount: 'transit',
          transitKey: 'hope-globalsetting',
        }),
    ).toThrow(/secret_id/i);
  });

  it('accepts a valid config (raw secret_id)', () => {
    const p = new VaultSecretsProvider(cfg());
    expect(p).toBeDefined();
  });

  it('accepts a valid config (wrapped secret_id)', () => {
    const p = new VaultSecretsProvider(cfg({ secretId: undefined, wrappedSecretId: 'wrap.token' }));
    expect(p).toBeDefined();
  });
});

describe('VaultSecretsProvider.boot()', () => {
  it('unwraps a wrapped secret_id then logs in via AppRole', async () => {
    const mockUnwrap = vi
      .fn()
      .mockResolvedValue({ data: { secret_id: 'real-sid' } });
    const mockLogin = vi.fn().mockResolvedValue({
      auth: { client_token: 'hvs.xxx', lease_duration: 3600, renewable: true },
    });
    const p = new VaultSecretsProvider(
      cfg({ secretId: undefined, wrappedSecretId: 'wrap.token' }),
    );
    const mockClient: Record<string, unknown> & { token: string } = {
      token: '',
      unwrap: mockUnwrap,
      approleLogin: mockLogin,
    };
    (p as unknown as { client: unknown }).client = mockClient;
    await p.boot();
    // Unwrap is called with no args; the wrap token is set as the client's
    // auth token for the duration of the call (then cleared).
    expect(mockUnwrap).toHaveBeenCalledWith();
    expect(mockLogin).toHaveBeenCalledWith({ role_id: 'rid', secret_id: 'real-sid' });
    // After boot the client carries the AppRole client_token, not the wrap.
    expect(mockClient.token).toBe('hvs.xxx');
  });

  it('temporarily sets client.token to the wrap token during unwrap', async () => {
    // Verifies the contract: during the unwrap call the client is
    // authenticated AS the wrap token. We capture client.token inside
    // the unwrap mock to assert this without observable side-effects.
    let tokenDuringUnwrap = '';
    const mockClient: Record<string, unknown> & { token: string } = {
      token: '',
      unwrap: vi.fn(async () => {
        tokenDuringUnwrap = mockClient.token;
        return { data: { secret_id: 'real-sid' } };
      }),
      approleLogin: vi.fn().mockResolvedValue({
        auth: { client_token: 'hvs.session', lease_duration: 60, renewable: true },
      }),
    };
    const p = new VaultSecretsProvider(
      cfg({ secretId: undefined, wrappedSecretId: 'wrap.token' }),
    );
    (p as unknown as { client: unknown }).client = mockClient;
    await p.boot();
    expect(tokenDuringUnwrap).toBe('wrap.token');
  });

  it('uses raw secret_id without unwrap when wrappedSecretId is absent', async () => {
    const mockUnwrap = vi.fn();
    const mockLogin = vi.fn().mockResolvedValue({
      auth: { client_token: 'hvs.xxx', lease_duration: 3600, renewable: true },
    });
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = {
      unwrap: mockUnwrap,
      approleLogin: mockLogin,
    };
    await p.boot();
    expect(mockUnwrap).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalledWith({ role_id: 'rid', secret_id: 'sid' });
  });

  it('throws when boot is required but neither wrapped nor raw secret_id is usable', async () => {
    // construct with wrapped, then make unwrap return empty secret_id
    const p = new VaultSecretsProvider(
      cfg({ secretId: undefined, wrappedSecretId: 'wrap.token' }),
    );
    (p as unknown as { client: unknown }).client = {
      unwrap: vi.fn().mockResolvedValue({ data: {} }),
      approleLogin: vi.fn(),
    };
    await expect(p.boot()).rejects.toThrow(/no secret_id available/);
  });
});

describe('VaultSecretsProvider reads (kv-v2)', () => {
  function provider(read: (path: string) => Promise<unknown>) {
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = {
      read,
      approleLogin: vi
        .fn()
        .mockResolvedValue({ auth: { client_token: 't', lease_duration: 1, renewable: false } }),
    };
    return p;
  }

  it('getSecret reads secret/data/hope/<KEY> and returns .data.data.value', async () => {
    const mockRead = vi
      .fn()
      .mockResolvedValue({ data: { data: { value: 'shh' }, metadata: { version: 1 } } });
    const p = provider(mockRead);
    await p.boot();
    await expect(p.getSecret('JWT_SECRET_KEY')).resolves.toBe('shh');
    expect(mockRead).toHaveBeenCalledWith('secret/data/hope/JWT_SECRET_KEY');
  });

  it('getSecret throws when not booted', async () => {
    const p = provider(vi.fn());
    await expect(p.getSecret('K')).rejects.toThrow(/not booted/i);
  });

  it('getSecret throws on missing required secret', async () => {
    const err = { response: { statusCode: 404 } };
    const p = provider(vi.fn().mockRejectedValue(err));
    await p.boot();
    await expect(p.getSecret('MISSING')).rejects.toThrow(/not found|required/i);
  });

  it('getSecret returns empty string on 404 when required:false', async () => {
    const err = { response: { statusCode: 404 } };
    const p = provider(vi.fn().mockRejectedValue(err));
    await p.boot();
    await expect(p.getSecret('MISSING', { required: false })).resolves.toBe('');
  });

  it('getSecretOptional returns undefined on 404', async () => {
    const err = { response: { statusCode: 404 } };
    const p = provider(vi.fn().mockRejectedValue(err));
    await p.boot();
    await expect(p.getSecretOptional('MISSING')).resolves.toBeUndefined();
  });

  it('getSecretJson parses JSON value', async () => {
    const mockRead = vi
      .fn()
      .mockResolvedValue({ data: { data: { value: '{"a":1}' }, metadata: { version: 1 } } });
    const p = provider(mockRead);
    await p.boot();
    await expect(p.getSecretJson<{ a: number }>('K')).resolves.toEqual({ a: 1 });
  });

  it('getSecretJson throws on non-JSON value', async () => {
    const mockRead = vi
      .fn()
      .mockResolvedValue({ data: { data: { value: 'not-json' }, metadata: { version: 1 } } });
    const p = provider(mockRead);
    await p.boot();
    await expect(p.getSecretJson('K')).rejects.toThrow(/not valid JSON/);
  });
});

describe('VaultSecretsProvider bulk + health', () => {
  function provider(client: Record<string, unknown>) {
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = {
      approleLogin: vi
        .fn()
        .mockResolvedValue({ auth: { client_token: 't', lease_duration: 1, renewable: false } }),
      ...client,
    };
    return p;
  }

  it('getSecrets fetches multiple keys concurrently', async () => {
    const mockRead = vi.fn(async (path: string) => {
      const key = path.split('/').pop()!;
      return { data: { data: { value: `v-${key}` }, metadata: { version: 1 } } };
    });
    const p = provider({ read: mockRead });
    await p.boot();
    const out = await p.getSecrets(['A', 'B', 'C']);
    expect(out).toEqual({ A: 'v-A', B: 'v-B', C: 'v-C' });
  });

  it('getSecrets omits keys that fail (e.g. 404)', async () => {
    const mockRead = vi.fn(async (path: string) => {
      if (path.endsWith('/MISSING')) {
        throw { response: { statusCode: 404 } };
      }
      return { data: { data: { value: 'present' } } };
    });
    const p = provider({ read: mockRead });
    await p.boot();
    const out = await p.getSecrets(['HERE', 'MISSING']);
    expect(out).toEqual({ HERE: 'present' });
  });

  it('rotateSecret throws (use kv-v2 versioning instead)', async () => {
    const p = provider({});
    await expect(p.rotateSecret('K')).rejects.toThrow(/not supported/i);
  });

  it('health returns ok:true when sys/health says initialized && !sealed', async () => {
    const mockHealth = vi
      .fn()
      .mockResolvedValue({ initialized: true, sealed: false });
    const p = provider({ health: mockHealth });
    await p.boot();
    const h = await p.health();
    expect(h).toMatchObject({ ok: true, provider: 'vault' });
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('health returns ok:false when sys/health throws', async () => {
    const mockHealth = vi.fn().mockRejectedValue(new Error('refused'));
    const p = provider({ health: mockHealth });
    await p.boot();
    const h = await p.health();
    expect(h).toMatchObject({ ok: false, provider: 'vault' });
    expect(h.detail).toContain('refused');
  });

  it('health returns ok:false when sealed', async () => {
    const mockHealth = vi
      .fn()
      .mockResolvedValue({ initialized: true, sealed: true });
    const p = provider({ health: mockHealth });
    await p.boot();
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/sealed=true/);
  });
});

describe('VaultSecretsProvider transit helpers', () => {
  function provider(client: Record<string, unknown>) {
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = {
      approleLogin: vi
        .fn()
        .mockResolvedValue({ auth: { client_token: 't', lease_duration: 1, renewable: false } }),
      ...client,
    };
    return p;
  }

  it('encrypt base64-encodes plaintext and returns ciphertext', async () => {
    const mockWrite = vi
      .fn()
      .mockResolvedValue({ data: { ciphertext: 'vault:v1:abc==' } });
    const p = provider({ write: mockWrite });
    await p.boot();
    const ct = await p.encrypt(Buffer.from('hello'));
    expect(mockWrite).toHaveBeenCalledWith('transit/encrypt/hope-globalsetting', {
      plaintext: 'aGVsbG8=',
    });
    expect(ct).toBe('vault:v1:abc==');
  });

  it('encrypt throws on empty ciphertext response', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ data: {} });
    const p = provider({ write: mockWrite });
    await p.boot();
    await expect(p.encrypt(Buffer.from('x'))).rejects.toThrow(/empty ciphertext/);
  });

  it('decrypt sends ciphertext and returns base64-decoded plaintext', async () => {
    const mockWrite = vi
      .fn()
      .mockResolvedValue({ data: { plaintext: 'aGVsbG8=' } });
    const p = provider({ write: mockWrite });
    await p.boot();
    const pt = await p.decrypt('vault:v1:abc==');
    expect(pt.toString('utf8')).toBe('hello');
  });

  it('decrypt throws on empty plaintext response', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ data: {} });
    const p = provider({ write: mockWrite });
    await p.boot();
    await expect(p.decrypt('vault:v1:abc==')).rejects.toThrow(/empty plaintext/);
  });

  it('issueDbCredential reads database/creds/<role> and returns shape', async () => {
    const mockRead = vi.fn().mockResolvedValue({
      lease_id: 'db/creds/r/abc',
      lease_duration: 3600,
      data: { username: 'v-u-1', password: 'pw' },
    });
    const p = provider({ read: mockRead });
    await p.boot();
    const cred = await p.issueDbCredential('hope-app-role');
    expect(mockRead).toHaveBeenCalledWith('database/creds/hope-app-role');
    expect(cred).toEqual({
      username: 'v-u-1',
      password: 'pw',
      leaseId: 'db/creds/r/abc',
      ttlSec: 3600,
    });
  });

  it('issueDbCredential throws on empty creds', async () => {
    const mockRead = vi.fn().mockResolvedValue({ data: {} });
    const p = provider({ read: mockRead });
    await p.boot();
    await expect(p.issueDbCredential('r')).rejects.toThrow(/empty creds/);
  });

  // The lease-renewal machinery existed (VaultLeaseRenewer) but
  // nothing could actually call Vault's renew endpoint for a DB lease. This
  // is that call: POST sys/leases/renew, surfaced via node-vault's
  // generated client.renew({ lease_id, increment }).
  it('renewDbLease renews sys/leases/renew with lease_id + increment and returns the new TTL', async () => {
    const mockRenew = vi.fn().mockResolvedValue({
      lease_id: 'database/creds/hope-app-role/abc',
      renewable: true,
      lease_duration: 3600,
    });
    const p = provider({ renew: mockRenew });
    await p.boot();
    const result = await p.renewDbLease('database/creds/hope-app-role/abc', 3600);
    expect(mockRenew).toHaveBeenCalledWith({
      lease_id: 'database/creds/hope-app-role/abc',
      increment: 3600,
    });
    expect(result).toEqual({ ttlSec: 3600 });
  });

  it('renewDbLease propagates a rejected/expired-lease error from Vault', async () => {
    const mockRenew = vi.fn().mockRejectedValue(new Error('lease not found'));
    const p = provider({ renew: mockRenew });
    await p.boot();
    await expect(p.renewDbLease('dead-lease', 3600)).rejects.toThrow(/lease not found/);
  });
});

// PHI field-encryption
// needs a SECOND Transit key (`hope-phi`) so clinical content rotates and is
// policy-scoped independently from the `hope-globalsetting` secrets key. The
// provider gains an OPTIONAL keyName parameter on encrypt/decrypt (default
// stays `transitKey` for backward compatibility) plus a `phiTransitKey` getter.
describe('VaultSecretsProvider keyed transit (Phase 3A PHI)', () => {
  function provider(client: Record<string, unknown>, overrides: Partial<VaultProviderConfig> = {}) {
    const p = new VaultSecretsProvider(cfg(overrides));
    (p as unknown as { client: unknown }).client = {
      approleLogin: vi
        .fn()
        .mockResolvedValue({ auth: { client_token: 't', lease_duration: 1, renewable: false } }),
      ...client,
    };
    return p;
  }

  it('encrypt(plaintext) without a key name uses the default transitKey (backward compatible)', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ data: { ciphertext: 'vault:v1:abc==' } });
    const p = provider({ write: mockWrite });
    await p.boot();
    await p.encrypt(Buffer.from('hello'));
    expect(mockWrite).toHaveBeenCalledWith('transit/encrypt/hope-globalsetting', {
      plaintext: 'aGVsbG8=',
    });
  });

  it('encrypt(plaintext, keyName) routes to the named transit key', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ data: { ciphertext: 'vault:v1:abc==' } });
    const p = provider({ write: mockWrite });
    await p.boot();
    await p.encrypt(Buffer.from('hello'), 'hope-phi');
    expect(mockWrite).toHaveBeenCalledWith('transit/encrypt/hope-phi', {
      plaintext: 'aGVsbG8=',
    });
  });

  it('decrypt(ciphertext, keyName) routes to the named transit key', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ data: { plaintext: 'aGVsbG8=' } });
    const p = provider({ write: mockWrite });
    await p.boot();
    const pt = await p.decrypt('vault:v2:abc==', 'hope-phi');
    expect(mockWrite).toHaveBeenCalledWith('transit/decrypt/hope-phi', { ciphertext: 'vault:v2:abc==' });
    expect(pt.toString('utf8')).toBe('hello');
  });

  it('phiTransitKey defaults to "hope-phi" when transitKeyPhi is unset', () => {
    const p = provider({});
    expect(p.phiTransitKey).toBe('hope-phi');
  });

  it('phiTransitKey honors an explicit transitKeyPhi config (ops override)', () => {
    const p = provider({}, { transitKeyPhi: 'hope-phi-prod' });
    expect(p.phiTransitKey).toBe('hope-phi-prod');
  });
});

// (B.1–B.4) — AppRole token renewal. boot() captures the
// login lease_duration/renewable but the pre-B build never renewed, so a prod
// pod 403s when the token hits token_max_ttl. These tests pin the renew-at-50%
// loop, degraded-after-N-failures health signal, recovery, and shutdown cancel.
describe('VaultSecretsProvider AppRole token renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Boot a provider with a controllable login + renew + health mock client. */
  async function bootRenewable(opts: {
    loginTtl?: number;
    renewable?: boolean;
    renewSelf?: ReturnType<typeof vi.fn>;
    health?: ReturnType<typeof vi.fn>;
  }) {
    const p = new VaultSecretsProvider(cfg());
    const client: Record<string, unknown> & { token: string } = {
      token: '',
      approleLogin: vi.fn().mockResolvedValue({
        auth: {
          client_token: 'hvs.session',
          lease_duration: opts.loginTtl ?? 3600,
          renewable: opts.renewable ?? true,
        },
      }),
      tokenRenewSelf:
        opts.renewSelf ??
        vi.fn().mockResolvedValue({ auth: { lease_duration: 3600, renewable: true } }),
      health: opts.health ?? vi.fn().mockResolvedValue({ initialized: true, sealed: false }),
    };
    (p as unknown as { client: unknown }).client = client;
    await p.boot();
    return { p, client };
  }

  it('schedules tokenRenewSelf at 50% of the AppRole token TTL', async () => {
    const renewSelf = vi
      .fn()
      .mockResolvedValue({ auth: { lease_duration: 3600, renewable: true } });
    const { p } = await bootRenewable({ loginTtl: 3600, renewSelf });

    expect(renewSelf).not.toHaveBeenCalled();
    // Just shy of 50% — must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(1_799_000);
    expect(renewSelf).toHaveBeenCalledTimes(0);
    // Crossing 50% (1800s) fires the first renewal.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewSelf).toHaveBeenCalledTimes(1);

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
  });

  it('reschedules at 50% of the freshly-returned TTL after each renewal', async () => {
    // login TTL 3600 → first tick at 1800s; renewal returns 60 → next at 30s.
    const renewSelf = vi
      .fn()
      .mockResolvedValue({ auth: { lease_duration: 60, renewable: true } });
    const { p } = await bootRenewable({ loginTtl: 3600, renewSelf });

    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(renewSelf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewSelf).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewSelf).toHaveBeenCalledTimes(3);

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
  });

  it('does not schedule renewal for a non-renewable token', async () => {
    const renewSelf = vi.fn();
    const { p } = await bootRenewable({ loginTtl: 3600, renewable: false, renewSelf });

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(renewSelf).not.toHaveBeenCalled();

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
  });

  it('reports degraded=true in health() after 3 consecutive renewal failures', async () => {
    const renewSelf = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('500'), { response: { statusCode: 500 } }));
    const health = vi.fn().mockResolvedValue({ initialized: true, sealed: false });
    const { p } = await bootRenewable({ loginTtl: 3600, renewSelf, health });

    // Each failure reschedules at 50% of the last-known TTL (3600 → 1800s).
    await vi.advanceTimersByTimeAsync(1_800_000); // failure 1
    await vi.advanceTimersByTimeAsync(1_800_000); // failure 2
    expect((await p.health()).degraded).toBeFalsy();
    await vi.advanceTimersByTimeAsync(1_800_000); // failure 3 → degraded
    expect(renewSelf).toHaveBeenCalledTimes(3);

    const h = await p.health();
    expect(h.degraded).toBe(true);
    // Vault itself is healthy; degraded is a warning, not a hard failure.
    expect(h.ok).toBe(true);

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
  });

  it('clears degraded after a renewal succeeds again', async () => {
    const renewSelf = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('500'), { response: { statusCode: 500 } }))
      .mockRejectedValueOnce(Object.assign(new Error('500'), { response: { statusCode: 500 } }))
      .mockRejectedValueOnce(Object.assign(new Error('500'), { response: { statusCode: 500 } }))
      .mockResolvedValue({ auth: { lease_duration: 3600, renewable: true } });
    const { p } = await bootRenewable({ loginTtl: 3600, renewSelf });

    await vi.advanceTimersByTimeAsync(1_800_000); // fail 1
    await vi.advanceTimersByTimeAsync(1_800_000); // fail 2
    await vi.advanceTimersByTimeAsync(1_800_000); // fail 3 → degraded
    expect((await p.health()).degraded).toBe(true);

    await vi.advanceTimersByTimeAsync(1_800_000); // success → recover
    expect((await p.health()).degraded).toBeFalsy();

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
  });

  it('cancels the renewal loop on shutdown (onModuleDestroy)', async () => {
    const renewSelf = vi
      .fn()
      .mockResolvedValue({ auth: { lease_duration: 3600, renewable: true } });
    const { p } = await bootRenewable({ loginTtl: 3600, renewSelf });

    await (p as unknown as { onModuleDestroy: () => Promise<void> }).onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(renewSelf).not.toHaveBeenCalled();
  });
});

// (B.7/B.8) — fail-closed boot. A sealed/unreachable Vault
// at startup must abort the boot with ONE clear, secret-free FATAL line (k8s
// then restarts the pod) rather than leaking a raw node-vault stack/body.
describe('VaultSecretsProvider.boot() fail-closed', () => {
  it('throws a single FATAL-shaped error when AppRole login hits a sealed/unreachable Vault', async () => {
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = {
      approleLogin: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Status 503'), { response: { statusCode: 503 } })),
    };
    await expect(p.boot()).rejects.toThrow(/FATAL/);
    await expect(p.boot()).rejects.toThrow(/vault/i);
  });

  it('does not retry AppRole login on boot (fails fast, single attempt)', async () => {
    const approleLogin = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Status 503'), { response: { statusCode: 503 } }));
    const p = new VaultSecretsProvider(cfg());
    (p as unknown as { client: unknown }).client = { approleLogin };
    await expect(p.boot()).rejects.toThrow(/FATAL/);
    expect(approleLogin).toHaveBeenCalledTimes(1);
  });

  it('does not leak the wrapped secret_id in the boot failure message', async () => {
    const p = new VaultSecretsProvider(cfg({ secretId: undefined, wrappedSecretId: 'super-secret-wrap-token' }));
    (p as unknown as { client: unknown }).client = {
      token: '',
      unwrap: vi.fn().mockRejectedValue(new Error('unwrap failed')),
      approleLogin: vi.fn(),
    };
    const error = await p.boot().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/FATAL/);
    expect((error as Error).message).not.toContain('super-secret-wrap-token');
  });
});
