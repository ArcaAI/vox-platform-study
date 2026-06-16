/**
 * TASK-352 — Vault-aware API_KEY_PEPPER resolution for the API-key seed.
 *
 * Dev runs with SECRETS_PROVIDER=vault: the API validates keys with
 * HMAC-SHA256 using the pepper stored in Vault KV
 * (secret/hope/API_KEY_PEPPER, seeded by dev-init.sh), while the seed
 * historically hashed with `process.env.API_KEY_PEPPER` only — blank in
 * the tracked .env.dev (TASK-348 MAJ-7) — producing plain-SHA-256 rows
 * that 401 against the running API (recurrence of the TASK-342
 * 2026-06-10 incident).
 *
 * `resolveApiKeyPepper` closes the gap at the seed level:
 *   1. non-empty process.env.API_KEY_PEPPER wins (CI / .env.test parity)
 *   2. else, SECRETS_PROVIDER=vault → read the pepper from Vault KV v2
 *      (failure THROWS: silently seeding plain-SHA rows in vault mode is
 *      exactly the bug this module exists to prevent)
 *   3. else → undefined (plain SHA-256, env-provider parity)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';

import { resolveApiKeyPepper } from '../api-key-pepper';
import { seedApiKey, DEFAULT_API_KEYS } from '../02-apikey';

const VAULT_PEPPER = 'dev-api-key-pepper-not-for-prod';

function stubVaultFetch(value: string = VAULT_PEPPER) {
    const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ data: { data: { value } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.stubEnv('API_KEY_PEPPER', '');
    vi.stubEnv('SECRETS_PROVIDER', '');
    vi.stubEnv('VAULT_ADDR', 'http://localhost:8200');
    vi.stubEnv('VAULT_TOKEN', '');
    vi.stubEnv('VAULT_DEV_ROOT_TOKEN', '');
    vi.stubEnv('VAULT_KV_MOUNT', '');
    vi.stubEnv('VAULT_KV_PREFIX', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('resolveApiKeyPepper', () => {
    it('returns process.env.API_KEY_PEPPER when non-empty, without contacting Vault', async () => {
        vi.stubEnv('API_KEY_PEPPER', 'env-pepper');
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        const fetchMock = stubVaultFetch();

        await expect(resolveApiKeyPepper()).resolves.toBe('env-pepper');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns undefined when no env pepper and SECRETS_PROVIDER is not vault', async () => {
        const fetchMock = stubVaultFetch();

        await expect(resolveApiKeyPepper()).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the pepper from Vault KV v2 when SECRETS_PROVIDER=vault', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubEnv('VAULT_DEV_ROOT_TOKEN', 'root');
        const fetchMock = stubVaultFetch();

        await expect(resolveApiKeyPepper()).resolves.toBe(VAULT_PEPPER);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://localhost:8200/v1/secret/data/hope/API_KEY_PEPPER');
        expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('root');
    });

    it('honours VAULT_KV_MOUNT / VAULT_KV_PREFIX overrides', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubEnv('VAULT_KV_MOUNT', 'kv');
        vi.stubEnv('VAULT_KV_PREFIX', 'acme');
        const fetchMock = stubVaultFetch();

        await resolveApiKeyPepper();

        const [url] = fetchMock.mock.calls[0] as unknown as [string];
        expect(url).toBe('http://localhost:8200/v1/kv/data/acme/API_KEY_PEPPER');
    });

    it('prefers VAULT_TOKEN over VAULT_DEV_ROOT_TOKEN, defaulting to "root"', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');

        let fetchMock = stubVaultFetch();
        vi.stubEnv('VAULT_TOKEN', 'explicit-token');
        vi.stubEnv('VAULT_DEV_ROOT_TOKEN', 'dev-root');
        await resolveApiKeyPepper();
        let [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('explicit-token');

        fetchMock = stubVaultFetch();
        vi.stubEnv('VAULT_TOKEN', '');
        vi.stubEnv('VAULT_DEV_ROOT_TOKEN', '');
        await resolveApiKeyPepper();
        [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('root');
    });

    it('throws an actionable error when Vault is configured but unreachable', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }));

        await expect(resolveApiKeyPepper()).rejects.toThrow(/API_KEY_PEPPER/);
    });

    it('throws when Vault responds non-200 (e.g. secret missing)', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":[]}', { status: 404 })));

        await expect(resolveApiKeyPepper()).rejects.toThrow(/API_KEY_PEPPER/);
    });
});

describe('seedApiKey uses the resolved Vault pepper for keyHash (TASK-352)', () => {
    it('writes HMAC-SHA256(rawKey, vaultPepper) hashes when SECRETS_PROVIDER=vault', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        stubVaultFetch();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const upsert = vi.fn(async (_args: unknown) => ({}));
        const client = { apiKey: { upsert } } as never;

        await seedApiKey(client);

        expect(upsert).toHaveBeenCalledTimes(DEFAULT_API_KEYS.length);
        for (const [i, key] of DEFAULT_API_KEYS.entries()) {
            const expectedHash = createHmac('sha256', VAULT_PEPPER).update(key.rawKey).digest('hex');
            const args = upsert.mock.calls[i]![0] as unknown as {
                create: { keyHash: string };
                update: { keyHash: string };
            };
            expect(args.create.keyHash).toBe(expectedHash);
            expect(args.update.keyHash).toBe(expectedHash);
        }
    });

    it('propagates the resolution failure instead of silently seeding plain-SHA rows', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }));

        const upsert = vi.fn(async () => ({}));
        const client = { apiKey: { upsert } } as never;

        await expect(seedApiKey(client)).rejects.toThrow(/API_KEY_PEPPER/);
        expect(upsert).not.toHaveBeenCalled();
    });
});
