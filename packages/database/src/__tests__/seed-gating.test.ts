/**
 * Seed Gating + Secret-Safety Tests
 *
 * Verifies:
 *  1. Demo API-key fixtures (which embed raw secrets from 00-constants) are
 *     only seedable in development/test — the `shouldSeedApiKeys` predicate is
 *     the single source of truth reused by the seed orchestrator gate.
 *  2. `seedApiKey` is hard-gated (defence in depth): invoking it directly while
 *     NODE_ENV=production throws BEFORE any work and emits no raw secret.
 *  3. The confirmation logging never prints a raw secret — only a masked
 *     preview (`maskSecret`) that exposes at most the first 4 characters.
 *
 * These tests exercise the ACTUAL seed entrypoint/predicate, not duplicates.
 * They never touch a real database — the Prisma client is mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
    seedApiKey,
    shouldSeedApiKeys,
    maskSecret,
    DEFAULT_API_KEYS,
} from '../prisma/db_main/seed/02-apikey';
import { SEED_API_KEY_RAW } from '../prisma/db_main/seed/00-constants';

const RAW_SECRETS = Object.values(SEED_API_KEY_RAW);

type SeedClient = Parameters<typeof seedApiKey>[0];

/** Minimal mock of the only client surface `seedApiKey` touches. */
function makeMockClient() {
    const upsert = vi.fn().mockResolvedValue({});
    const client = { apiKey: { upsert } } as unknown as SeedClient;
    return { client, upsert };
}

describe('shouldSeedApiKeys (dev/test gate predicate)', () => {
    it('permits seeding in development and test', () => {
        expect(shouldSeedApiKeys('development')).toBe(true);
        expect(shouldSeedApiKeys('test')).toBe(true);
    });

    it('blocks seeding in production and staging', () => {
        expect(shouldSeedApiKeys('production')).toBe(false);
        expect(shouldSeedApiKeys('staging')).toBe(false);
    });
});

describe('maskSecret (no-secret logging)', () => {
    it('reveals at most the first 4 characters then masks the rest', () => {
        expect(maskSecret('hope_sk_test_abcdef_123456')).toBe('hope****');
    });

    it('never reproduces the body of any raw seed secret', () => {
        RAW_SECRETS.forEach((raw) => {
            const masked = maskSecret(raw);
            expect(masked).toBe(`${raw.slice(0, 4)}****`);
            // Nothing past the first 4 chars may leak into the masked label.
            expect(masked).not.toContain(raw.slice(4));
        });
    });
});

describe('seedApiKey production guard (defence in depth)', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('throws and emits no raw secret when NODE_ENV=production', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { client, upsert } = makeMockClient();

        await expect(seedApiKey(client)).rejects.toThrow(/development\/test/i);

        // The guard must short-circuit before any persistence or logging.
        expect(upsert).not.toHaveBeenCalled();
        const logged = logSpy.mock.calls.flat().map(String).join('\n');
        RAW_SECRETS.forEach((raw) => expect(logged).not.toContain(raw));
    });
});

describe('seedApiKey development seeding', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('permits seeding in development and logs only masked previews', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { client, upsert } = makeMockClient();

        await seedApiKey(client);

        // Seeding proceeded: one upsert per default key.
        expect(upsert).toHaveBeenCalledTimes(DEFAULT_API_KEYS.length);

        const logged = logSpy.mock.calls.flat().map(String).join('\n');
        // Not a single console.log argument carried a raw secret.
        RAW_SECRETS.forEach((raw) => expect(logged).not.toContain(raw));
        // ...but a masked preview WAS logged (confirmation log uses the mask).
        expect(logged).toContain('hope****');
    });
});
