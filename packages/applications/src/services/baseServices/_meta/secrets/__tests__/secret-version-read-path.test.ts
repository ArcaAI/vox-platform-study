// TASK-558 lane J (J5) — the kv-v2 VERSIONED read path.
//
// `API_KEY_PEPPER` is the one platform secret whose rotation is a cliff rather
// than a blip: an ApiKey hash computed under pepper vN can never be verified
// under vN+1, so swapping it invalidates every issued key at once (plan §9.2 L6,
// and the descriptor's own long-form note). The staged alternative the plan
// prescribes needs exactly two things:
//
//   1. a per-row record of WHICH pepper version produced the stored hash, and
//   2. a read path that can fetch THAT version rather than "latest".
//
// (1) is a schema change on `ApiKey` plus the domain trio and the issue/verify
// services — out of this lane's scope and explicitly reported as such. (2) is
// the SecretsService/Vault surface, which is this lane's, and is what this test
// pins. Vault kv-v2 retains prior versions natively, so the mechanism exists;
// nothing in the codebase could ADDRESS it before.
//
// The cache is the subtle part: versions are distinct values under one name, so
// a version-blind cache key would serve v3 to a caller asking for v2.
import { describe, expect, it, vi } from 'vitest';
import { SecretsService } from '../SecretsService';
import { VaultSecretsProvider } from '../providers/vault-secrets.provider';
import type { ISecretsProvider, SecretFetchOptions } from '../ISecretsProvider';

/** Minimal node-vault stand-in that records the paths it was asked to read. */
function fakeVaultClient(valueByPath: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    client: {
      token: 't',
      read: vi.fn(async (path: string) => {
        reads.push(path);
        const value = valueByPath[path];
        if (value === undefined) {
          throw Object.assign(new Error('not found'), { response: { statusCode: 404 } });
        }
        return { data: { data: { value } } };
      }),
      write: vi.fn(),
      approleLogin: vi.fn(),
      renew: vi.fn(),
      tokenRenewSelf: vi.fn(),
      unwrap: vi.fn(),
      health: vi.fn(),
    },
  };
}

function bootedVaultProvider(valueByPath: Record<string, string>) {
  const fake = fakeVaultClient(valueByPath);
  const provider = new VaultSecretsProvider({
    addr: 'http://vault.test:8200',
    roleId: 'role',
    secretId: 'secret',
    kvMount: 'secret',
    kvPrefix: 'hope',
  });
  // Inject the fake transport and mark it booted without an AppRole round-trip.
  (provider as unknown as { client: unknown }).client = fake.client;
  (provider as unknown as { booted: boolean }).booted = true;
  return { provider, reads: fake.reads };
}

describe('kv-v2 versioned secret reads (plan §9.2 L6 — staged rotation)', () => {
  it('reads the latest version when no version is requested', async () => {
    const { provider, reads } = bootedVaultProvider({ 'secret/data/hope/API_KEY_PEPPER': 'pepper-v3' });

    await expect(provider.getSecret('API_KEY_PEPPER')).resolves.toBe('pepper-v3');
    expect(reads).toEqual(['secret/data/hope/API_KEY_PEPPER']);
  });

  it('addresses a specific kv-v2 version when one is requested', async () => {
    const { provider, reads } = bootedVaultProvider({
      'secret/data/hope/API_KEY_PEPPER': 'pepper-v3',
      'secret/data/hope/API_KEY_PEPPER?version=2': 'pepper-v2',
    });

    await expect(provider.getSecret('API_KEY_PEPPER', { version: 2 })).resolves.toBe('pepper-v2');
    expect(reads).toEqual(['secret/data/hope/API_KEY_PEPPER?version=2']);
  });

  it('caches versions independently — a v2 request never receives the latest value', async () => {
    const values: Record<string, string> = { LATEST: 'pepper-v3', V2: 'pepper-v2' };
    const calls: Array<number | undefined> = [];
    const provider: ISecretsProvider = {
      name: 'vault',
      getSecret: async (_key: string, opts?: SecretFetchOptions) => {
        calls.push(opts?.version);
        return opts?.version === 2 ? values.V2 : values.LATEST;
      },
      getSecretOptional: async () => undefined,
      getSecretJson: async () => ({}) as never,
      getSecrets: async () => ({}),
      rotateSecret: async () => undefined,
      health: async () => ({ ok: true, latencyMs: 0, provider: 'vault' }),
    };
    const svc = new SecretsService(provider);

    expect(await svc.getSecret('API_KEY_PEPPER')).toBe('pepper-v3');
    expect(await svc.getSecret('API_KEY_PEPPER', { version: 2 })).toBe('pepper-v2');
    // Both are now cached, each under its own identity.
    expect(await svc.getSecret('API_KEY_PEPPER')).toBe('pepper-v3');
    expect(await svc.getSecret('API_KEY_PEPPER', { version: 2 })).toBe('pepper-v2');

    expect(calls).toEqual([undefined, 2]);
  });

  it('invalidate(key) drops every cached version of that key', async () => {
    let served = 'pepper-v2';
    const provider: ISecretsProvider = {
      name: 'vault',
      getSecret: async () => served,
      getSecretOptional: async () => undefined,
      getSecretJson: async () => ({}) as never,
      getSecrets: async () => ({}),
      rotateSecret: async () => undefined,
      health: async () => ({ ok: true, latencyMs: 0, provider: 'vault' }),
    };
    const svc = new SecretsService(provider);

    await svc.getSecret('API_KEY_PEPPER', { version: 2 });
    served = 'pepper-v2-rewritten';
    svc.invalidate('API_KEY_PEPPER');

    expect(await svc.getSecret('API_KEY_PEPPER', { version: 2 })).toBe('pepper-v2-rewritten');
  });
});
