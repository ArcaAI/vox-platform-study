// Phase 2B (TASK-302 Stream B) - VaultSecretsProvider unit tests.
//
// All tests in this file use a mocked node-vault client (assigned via
// `(p as unknown as { client: ... }).client = ...`) so they run with no
// network. The dev-container integration test lives in
// vault-secrets.provider.integration.test.ts.
import { describe, it, expect, vi } from 'vitest';
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
    (p as unknown as { client: unknown }).client = {
      unwrap: mockUnwrap,
      approleLogin: mockLogin,
    };
    await p.boot();
    expect(mockUnwrap).toHaveBeenCalledWith({ token: 'wrap.token' });
    expect(mockLogin).toHaveBeenCalledWith({ role_id: 'rid', secret_id: 'real-sid' });
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
});
