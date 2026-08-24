/**
 * TASK-799 Round 4 lane B — the seed must actually PERSIST key material.
 *
 * `config-plane-seed.test.ts` asserts the exported seed DATA: which rows exist,
 * which are enabled, which declare `apiKeyPlaintext`. That is necessary and not
 * sufficient — declaring a placeholder that `seedAiProviderConnection` never
 * writes into `encryptedApiKey` produces exactly the failure this lane exists to
 * eliminate: a seed that looks correct and silently does nothing, because the
 * `provider_overrides` fold drops any row whose `encryptedApiKey` is NULL.
 *
 * So this file drives the seed FUNCTION against a fake Prisma client and a fake
 * Vault, and asserts on the `create()` payload.
 *
 * Environment split, both directions covered:
 *   - `SECRETS_PROVIDER=vault`  ⇒ the four self-host llm rows are created WITH
 *     ciphertext + keyVersion, under the SECRETS transit key (never `hope-phi`).
 *   - anything else            ⇒ no Vault contact, rows created keyless. That is
 *     the correct degraded outcome (without a `SecretsService` the runtime
 *     resolver returns no overrides at all), and it must not abort the seed —
 *     the same soft-mode contract `phi-encryption.test.ts` pins for PHI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the `vi.mock` factory can reference them (Vitest hoists vi.mock
// above imports). Mirrors `phi-encryption.test.ts` — the seed reaches Vault via
// `node-vault`'s default export → `client.write(...)`.
const { writeMock, vaultFactory } = vi.hoisted(() => {
  const writeMock = vi.fn(async () => ({ data: { ciphertext: 'vault:v7:Y2lwaGVy' } }));
  const vaultFactory = vi.fn(() => ({ write: writeMock }) as Record<string, unknown>);
  return { writeMock, vaultFactory };
});
vi.mock('node-vault', () => ({ default: vaultFactory }));

interface CreatedRow {
  service: string;
  provider: string;
  encryptedApiKey?: Uint8Array;
  keyVersion?: number;
}

/** Minimal stand-in for the bits of `CorePrismaClient` the seed touches. */
const fakeClient = (created: CreatedRow[]) =>
  ({
    aiProviderConnection: {
      findFirst: async () => null,
      create: async ({ data }: { data: CreatedRow }) => {
        created.push(data);
        return data;
      },
    },
  }) as unknown as Parameters<typeof import('../17-ai-provider-connection').seedAiProviderConnection>[0];

/** Fresh module graph per test so the memoised Vault client never leaks across cases. */
const loadSeed = async () => (await import('../17-ai-provider-connection')).seedAiProviderConnection;

/** The engines `apps/text` registers a self-host provider factory for. */
const TEXT_SELF_HOST_ENGINES = ['llm:lm-studio', 'llm:ollama', 'llm:vllm', 'llm:llama-cpp'];

beforeEach(() => {
  vi.resetModules();
  writeMock.mockClear();
  vaultFactory.mockClear();
  vi.stubEnv('SECRETS_PROVIDER', '');
  vi.stubEnv('VAULT_ADDR', '');
  vi.stubEnv('VAULT_TOKEN', '');
  vi.stubEnv('VAULT_TRANSIT_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('seedAiProviderConnection — key material (SECRETS_PROVIDER=vault)', () => {
  beforeEach(() => {
    vi.stubEnv('SECRETS_PROVIDER', 'vault');
    vi.stubEnv('VAULT_ADDR', 'http://localhost:8200');
    vi.stubEnv('VAULT_TOKEN', 'dev-root');
  });

  it('persists ciphertext + keyVersion for every text-served self-host engine', async () => {
    const created: CreatedRow[] = [];
    await (await loadSeed())(fakeClient(created));

    for (const pair of TEXT_SELF_HOST_ENGINES) {
      const row = created.find((r) => `${r.service}:${r.provider}` === pair);
      expect(row, `${pair} must be created`).toBeDefined();
      // Without these two columns the override fold skips the row and text 503s.
      expect(row!.encryptedApiKey, `${pair} must be created WITH ciphertext`).toBeInstanceOf(Uint8Array);
      // The column holds the raw Transit string as UTF-8 bytes — byte-identical
      // to what `encryptSecretField` writes, so `toOverrideEntry` round-trips it.
      expect(Buffer.from(row!.encryptedApiKey!).toString('utf8')).toBe('vault:v7:Y2lwaGVy');
      expect(row!.keyVersion, `${pair} keyVersion is parsed out of the Transit ciphertext`).toBe(7);
    }
  });

  it('encrypts under the SECRETS transit key, never the PHI key', async () => {
    await (await loadSeed())(fakeClient([]));

    const paths = writeMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(paths.length).toBeGreaterThan(0);
    // `AiProviderConnection.encryptedApiKey` is written by `encryptSecretField`
    // with no keyName, i.e. under SecretsService's default transit key. Seeding
    // under `hope-phi` would yield a row the runtime cannot decrypt.
    paths.forEach((path) => {
      expect(path).toBe('transit/encrypt/hope-globalsetting');
    });
  });

  it('honours VAULT_TRANSIT_KEY, so a deployment that renamed the key still round-trips', async () => {
    vi.stubEnv('VAULT_TRANSIT_KEY', 'hope-secrets-alt');
    await (await loadSeed())(fakeClient([]));

    const paths = writeMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(new Set(paths)).toEqual(new Set(['transit/encrypt/hope-secrets-alt']));
  });

  it('still creates every cloud-BYO row keyless (a keyed SYSTEM cloud row is platform spend)', async () => {
    const created: CreatedRow[] = [];
    await (await loadSeed())(fakeClient(created));

    const cloud = created.filter((r) => !TEXT_SELF_HOST_ENGINES.includes(`${r.service}:${r.provider}`));
    expect(cloud.length).toBeGreaterThan(0);
    cloud.forEach((r) => {
      expect(r.encryptedApiKey, `${r.service}:${r.provider} must stay keyless`).toBeUndefined();
      expect(r.keyVersion).toBeUndefined();
    });
  });
});

describe('seedAiProviderConnection — no Vault (soft mode)', () => {
  it('creates the rows keyless without contacting Vault, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const created: CreatedRow[] = [];

    await (await loadSeed())(fakeClient(created));

    expect(vaultFactory).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    created.forEach((r) => expect(r.encryptedApiKey).toBeUndefined());
    // The 503 that follows must be predictable, not discovered at runtime.
    expect(warn.mock.calls.flat().join(' ')).toContain('SECRETS_PROVIDER != vault');
  });
});
