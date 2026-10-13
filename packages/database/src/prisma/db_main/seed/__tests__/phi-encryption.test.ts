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
const { writeMock, unwrapMock, loginMock, vaultFactory } = vi.hoisted(() => {
  const writeMock = vi.fn(async (): Promise<unknown> => ({ data: { ciphertext: 'vault:v3:QkFTRTY0' } }));
  const unwrapMock = vi.fn(async (): Promise<unknown> => ({ data: { secret_id: 'unwrapped-sid' } }));
  const loginMock = vi.fn(async (): Promise<unknown> => ({ auth: { client_token: 'approle-token' } }));
  const vaultFactory = vi.fn(() => ({ write: writeMock, unwrap: unwrapMock, approleLogin: loginMock }) as Record<string, unknown>);
  return { writeMock, unwrapMock, loginMock, vaultFactory };
});
vi.mock('node-vault', () => ({ default: vaultFactory }));

beforeEach(() => {
  // Fresh module each test → resets the memoised Vault client promise so the
  // fail-closed test never poisons the happy-path test (or vice-versa).
  vi.resetModules();
  writeMock.mockClear();
  unwrapMock.mockClear();
  loginMock.mockClear();
  vaultFactory.mockClear();
  // Default: the exact `.env.test` situation — no provider, no Vault address.
  vi.stubEnv('SECRETS_PROVIDER', '');
  vi.stubEnv('VAULT_ADDR', '');
  vi.stubEnv('VAULT_DEV_ROOT_TOKEN', '');
  vi.stubEnv('VAULT_TOKEN', '');
  vi.stubEnv('VAULT_ROLE_ID', '');
  vi.stubEnv('VAULT_WRAPPED_SECRET_ID', '');
  vi.stubEnv('VAULT_SECRET_ID', '');
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

    await expect(encryptSeedRow('ContextItem', { id: 'c1', tenantId: 't1', content: 'PHI text' })).resolves.toMatchObject({
      id: 'c1',
      tenantId: 't1',
    });
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

    await expect(encryptSeedRow('ContextItem', { id: 'c1', tenantId: 't1', content: 'PHI text' })).rejects.toThrow(/VAULT_ADDR is required/);
  });
});

// ---------------------------------------------------------------------------
// Required mode without a root token: the AppRole login (TASK-1067)
// ---------------------------------------------------------------------------

describe('encryptSeedRow — AppRole authentication', () => {
  beforeEach(() => {
    vi.stubEnv('SECRETS_PROVIDER', 'vault');
    vi.stubEnv('VAULT_ADDR', 'http://localhost:8200');
  });

  const row = { id: 'c1', tenantId: 't1', content: 'PHI text' };

  it('unwraps a WRAPPED secret_id, logs in with it, and encrypts under the AppRole token', async () => {
    vi.stubEnv('VAULT_ROLE_ID', 'role-1');
    vi.stubEnv('VAULT_WRAPPED_SECRET_ID', 'wrap-token');
    const encryptSeedRow = await loadEncryptSeedRow();

    await encryptSeedRow('ContextItem', row);

    expect(unwrapMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith({ role_id: 'role-1', secret_id: 'unwrapped-sid' });
    const client = vaultFactory.mock.results[0]!.value as { token?: string };
    // The wrapping token is only borrowed for the unwrap call; the client ends on the login token.
    expect(client.token).toBe('approle-token');
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('logs in with a DIRECT secret_id when no wrapped one is set', async () => {
    vi.stubEnv('VAULT_ROLE_ID', 'role-1');
    vi.stubEnv('VAULT_SECRET_ID', 'direct-sid');
    const encryptSeedRow = await loadEncryptSeedRow();

    await encryptSeedRow('ContextItem', row);

    expect(unwrapMock).not.toHaveBeenCalled();
    expect(loginMock).toHaveBeenCalledWith({ role_id: 'role-1', secret_id: 'direct-sid' });
  });

  it.each([
    ['VAULT_ROLE_ID is missing', {}, /VAULT_ROLE_ID is required/],
    ['no secret_id is configured', { VAULT_ROLE_ID: 'role-1' }, /No secret_id/],
  ])('fails closed when %s', async (_label, env, error) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const encryptSeedRow = await loadEncryptSeedRow();

    await expect(encryptSeedRow('ContextItem', row)).rejects.toThrow(error);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('fails closed when the unwrap yields no secret_id', async () => {
    vi.stubEnv('VAULT_ROLE_ID', 'role-1');
    vi.stubEnv('VAULT_WRAPPED_SECRET_ID', 'wrap-token');
    unwrapMock.mockResolvedValueOnce({ data: {} });
    const encryptSeedRow = await loadEncryptSeedRow();

    await expect(encryptSeedRow('ContextItem', row)).rejects.toThrow(/unwrap returned no secret_id/);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('fails closed when the AppRole login returns no client_token', async () => {
    vi.stubEnv('VAULT_ROLE_ID', 'role-1');
    vi.stubEnv('VAULT_SECRET_ID', 'direct-sid');
    loginMock.mockResolvedValueOnce({ auth: {} });
    const encryptSeedRow = await loadEncryptSeedRow();

    await expect(encryptSeedRow('ContextItem', row)).rejects.toThrow(/did not return a client_token/);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe('encryptSeedRow — ciphertext handling in required mode', () => {
  beforeEach(() => {
    vi.stubEnv('SECRETS_PROVIDER', 'vault');
    vi.stubEnv('VAULT_ADDR', 'http://localhost:8200');
    vi.stubEnv('VAULT_DEV_ROOT_TOKEN', 'root');
  });

  it('refuses an empty ciphertext from Transit instead of persisting nothing as if it were encrypted', async () => {
    writeMock.mockResolvedValueOnce({ data: {} });
    const encryptSeedRow = await loadEncryptSeedRow();

    await expect(encryptSeedRow('ContextItem', { id: 'c1', content: 'PHI text' })).rejects.toThrow(/returned empty ciphertext/);
  });

  it.each([
    ['an unversioned ciphertext', 'vault:x:QkFTRTY0'],
    ['a version that is not a number', 'vault:vX:QkFTRTY0'],
    ['a ciphertext with no version segment', 'QkFTRTY0'],
  ])('falls back to key version 1 for %s', async (_label, ciphertext) => {
    writeMock.mockResolvedValueOnce({ data: { ciphertext } });
    const encryptSeedRow = await loadEncryptSeedRow();

    const out = (await encryptSeedRow('ContextItem', { id: 'c1', content: 'PHI text' })) as Record<string, unknown>;

    expect(out.contentKeyVersion).toBe(1);
  });

  it.each([null, undefined, ''])('leaves the encrypted column and key version unset for a %j value', async (value) => {
    const encryptSeedRow = await loadEncryptSeedRow();

    const out = await encryptSeedRow('ContextItem', { id: 'c1', content: value });

    expect(out).not.toHaveProperty('encryptedContent');
    expect(out).not.toHaveProperty('contentKeyVersion');
    expect(out).not.toHaveProperty('content');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('encrypts a JSON PHI field as its JSON string, and skips a null one', async () => {
    const encryptSeedRow = await loadEncryptSeedRow();

    const out = await encryptSeedRow('DnaWritingStyleReport', { id: 'r1', reportData: { tone: 'formal' }, styleText: null });

    expect(writeMock).toHaveBeenCalledTimes(1);
    const [, body] = writeMock.mock.calls[0] as unknown as [string, { plaintext: string }];
    expect(Buffer.from(body.plaintext, 'base64').toString('utf8')).toBe('{"tone":"formal"}');
    expect(out).toHaveProperty('encryptedReportData');
    expect(out).not.toHaveProperty('encryptedStyleText');
  });
});
