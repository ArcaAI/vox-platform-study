/**
 * Seed-time PHI encryption must mirror the APPLICATION
 * write-path's environment gate (`applications` `phi-field-encryption.ts`
 * `isPhiEncryptionRequired`): only `SECRETS_PROVIDER=vault` encrypts PHI.
 *
 * Regression: `encryptSeedRow` hard-required Vault UNCONDITIONALLY, so
 * `pnpm test:db:seed` (run under `.env.test`, which sets neither
 * `SECRETS_PROVIDER` nor `VAULT_ADDR`) threw
 *   "VAULT_ADDR is required to seed PHI ciphertext (SECRETS_PROVIDER=vault)."
 * That aborted `test:db:reset` inside Playwright `globalSetup`, failing the
 * whole E2E suite before a single test ran.
 *
 * Contract under test:
 *   - soft mode (`SECRETS_PROVIDER` != 'vault'): no Vault contact; strip the
 *     Phase-6 plaintext PHI keys; leave `encrypted*` + key-version columns unset
 *     (NULL) — byte-for-byte what the app persists on write in dev/test.
 *   - required mode (`SECRETS_PROVIDER` == 'vault'): encrypt via Vault Transit
 *     into the `encrypted*` columns; a missing `VAULT_ADDR` still fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the `vi.mock` factory can reference them safely (Vitest hoists
// vi.mock above imports). The seed talks to Vault via `node-vault`'s default
// export `vault({...})` → `client.write(...)`.
const { writeMock, vaultFactory } = vi.hoisted(() => {
    const writeMock = vi.fn(async () => ({ data: { ciphertext: 'vault:v3:QkFTRTY0' } }));
    const vaultFactory = vi.fn(() => ({ write: writeMock }) as Record<string, unknown>);
    return { writeMock, vaultFactory };
});
vi.mock('node-vault', () => ({ default: vaultFactory }));

beforeEach(() => {
    // Fresh module each test → resets the memoised Vault client promise so the
    // fail-closed test never poisons the happy-path test (or vice-versa).
    vi.resetModules();
    writeMock.mockClear();
    vaultFactory.mockClear();
    // Default: the exact `.env.test` situation — no provider, no Vault address.
    vi.stubEnv('SECRETS_PROVIDER', '');
    vi.stubEnv('VAULT_ADDR', '');
    vi.stubEnv('VAULT_DEV_ROOT_TOKEN', '');
    vi.stubEnv('VAULT_TOKEN', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

async function loadEncryptSeedRow() {
    return (await import('../phi-encryption')).encryptSeedRow;
}

describe('encryptSeedRow — environment gate', () => {
    it('soft no-op when SECRETS_PROVIDER is not vault: strips plaintext PHI, leaves encrypted*/keyVersion unset, never contacts Vault', async () => {
        const encryptSeedRow = await loadEncryptSeedRow();

        const out = await encryptSeedRow('DnaWritingStyleReport', {
            id: 'r1',
            tenantId: 't1',
            reportData: { tone: 'formal' },
            styleText: 'Writes concise notes.',
            name: 'keep-me',
        });

        // Phase-6 plaintext PHI keys are not real columns → always stripped.
        expect(out).not.toHaveProperty('reportData');
        expect(out).not.toHaveProperty('styleText');
        // Soft mode persists nothing PHI — encrypted* + keyVersion stay NULL.
        expect(out).not.toHaveProperty('encryptedReportData');
        expect(out).not.toHaveProperty('encryptedStyleText');
        expect(out).not.toHaveProperty('keyVersion');
        // Non-PHI columns pass through untouched.
        expect(out).toMatchObject({ id: 'r1', tenantId: 't1', name: 'keep-me' });
        // Crucially: no Vault round-trip in soft mode.
        expect(vaultFactory).not.toHaveBeenCalled();
        expect(writeMock).not.toHaveBeenCalled();
    });

    it('does NOT throw on missing VAULT_ADDR in soft mode (the exact bug that aborted test:db:seed)', async () => {
        const encryptSeedRow = await loadEncryptSeedRow();

        await expect(
            encryptSeedRow('ContextItem', { id: 'c1', tenantId: 't1', content: 'PHI text' }),
        ).resolves.toMatchObject({ id: 'c1', tenantId: 't1' });
    });

    it('required mode (SECRETS_PROVIDER=vault) encrypts via Vault Transit into the encrypted* + key-version columns', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        vi.stubEnv('VAULT_ADDR', 'http://localhost:8200');
        vi.stubEnv('VAULT_DEV_ROOT_TOKEN', 'root');
        const encryptSeedRow = await loadEncryptSeedRow();

        const out = (await encryptSeedRow('ContextItem', {
            id: 'c1',
            tenantId: 't1',
            content: 'PHI text',
        })) as Record<string, unknown>;

        expect(writeMock).toHaveBeenCalledTimes(1);
        expect(Buffer.isBuffer(out.encryptedContent)).toBe(true);
        expect((out.encryptedContent as Buffer).toString('utf8')).toBe('vault:v3:QkFTRTY0');
        // ContextItem records its version in `contentKeyVersion`; v3 → 3.
        expect(out.contentKeyVersion).toBe(3);
        expect(out).not.toHaveProperty('content');
    });

    it('required mode still fails closed when VAULT_ADDR is missing', async () => {
        vi.stubEnv('SECRETS_PROVIDER', 'vault');
        // VAULT_ADDR intentionally left empty.
        const encryptSeedRow = await loadEncryptSeedRow();

        await expect(
            encryptSeedRow('ContextItem', { id: 'c1', tenantId: 't1', content: 'PHI text' }),
        ).rejects.toThrow(/VAULT_ADDR is required/);
    });
});
