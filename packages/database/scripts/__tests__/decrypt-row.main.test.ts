/**
 * decrypt-row — the Vault wiring and the CLI entry point (TASK-1067).
 *
 * `decrypt-row.test.ts` covers the pure helpers. This file covers what they are
 * wired into: the AppRole login (shared with `dna-phi-scan.ts`), Transit decrypt,
 * and `main()` against a mocked Vault + Prisma — including the two properties
 * that make the tool safe to hand an operator: it only ever READS, and it always
 * disconnects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { vaultClient, vaultFactory, prisma } = vi.hoisted(() => {
  const vaultClient = {
    token: undefined as string | undefined,
    unwrap: vi.fn(async (): Promise<unknown> => ({ data: { secret_id: 'unwrapped-sid' } })),
    approleLogin: vi.fn(async (): Promise<unknown> => ({ auth: { client_token: 'approle-token' } })),
    write: vi.fn(async (): Promise<unknown> => ({ data: { plaintext: Buffer.from('the PHI note').toString('base64') } })),
  };
  const vaultFactory = vi.fn(() => vaultClient);
  const delegate = () => ({ findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() });
  const prisma: Record<string, any> = {
    contextItem: delegate(),
    auditLog: delegate(),
    $disconnect: vi.fn(async () => undefined),
  };
  return { vaultClient, vaultFactory, prisma };
});

vi.mock('node-vault', () => ({ default: vaultFactory }));
vi.mock('../../src/client.js', () => ({ getPlatformAdminPrismaClient_Unscoped: () => prisma }));

import { authenticateVaultClient, main, parseArgs, transitDecrypt, type VaultClientLike } from '../decrypt-row';

const VAULT_ENV = {
  SECRETS_PROVIDER: 'vault',
  VAULT_ADDR: 'http://vault:8200',
  VAULT_ROLE_ID: 'role-1',
  VAULT_SECRET_ID: 'direct-sid',
};

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vaultClient.token = undefined;
  for (const [k, v] of Object.entries(VAULT_ENV)) vi.stubEnv(k, v);
  vi.stubEnv('VAULT_WRAPPED_SECRET_ID', '');
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const client = () => vaultClient as unknown as VaultClientLike;

describe('authenticateVaultClient', () => {
  it('logs in with the direct secret_id and installs the client token', async () => {
    await authenticateVaultClient(client());

    expect(vaultClient.unwrap).not.toHaveBeenCalled();
    expect(vaultClient.approleLogin).toHaveBeenCalledWith({ role_id: 'role-1', secret_id: 'direct-sid' });
    expect(vaultClient.token).toBe('approle-token');
  });

  it('prefers a wrapped secret_id, borrowing the wrapping token only for the unwrap', async () => {
    vi.stubEnv('VAULT_WRAPPED_SECRET_ID', 'wrap-token');
    vaultClient.unwrap.mockImplementationOnce(async () => {
      expect(vaultClient.token).toBe('wrap-token');
      return { data: { secret_id: 'unwrapped-sid' } };
    });

    await authenticateVaultClient(client());

    expect(vaultClient.approleLogin).toHaveBeenCalledWith({ role_id: 'role-1', secret_id: 'unwrapped-sid' });
    expect(vaultClient.token).toBe('approle-token');
  });

  it('restores the previous token when the unwrap fails', async () => {
    vi.stubEnv('VAULT_WRAPPED_SECRET_ID', 'wrap-token');
    vaultClient.token = 'before';
    vaultClient.unwrap.mockResolvedValueOnce({ data: {} });

    await expect(authenticateVaultClient(client())).rejects.toThrow(/unwrap returned no secret_id/);
    expect(vaultClient.token).toBe('before');
  });

  it.each([
    ['VAULT_ADDR', /VAULT_ADDR and VAULT_ROLE_ID are required/],
    ['VAULT_ROLE_ID', /VAULT_ADDR and VAULT_ROLE_ID are required/],
    ['VAULT_SECRET_ID', /No secret_id available/],
  ])('fails closed without %s', async (name, error) => {
    vi.stubEnv(name, '');

    await expect(authenticateVaultClient(client())).rejects.toThrow(error);
    expect(vaultClient.token).toBeUndefined();
  });

  it('fails closed when the login returns no client_token', async () => {
    vaultClient.approleLogin.mockResolvedValueOnce({ auth: {} });

    await expect(authenticateVaultClient(client())).rejects.toThrow(/did not return a client_token/);
  });
});

describe('transitDecrypt', () => {
  const args = parseArgs(['tsx', 'decrypt-row.ts', '--transit-mount', 'tx', '--transit-key', 'k1']);

  it('decrypts under the requested mount and key', async () => {
    const out = await transitDecrypt(client(), args, 'vault:v1:abc');

    expect(vaultClient.write).toHaveBeenCalledWith('tx/decrypt/k1', { ciphertext: 'vault:v1:abc' });
    expect(out.toString('utf8')).toBe('the PHI note');
  });

  it('refuses an empty Transit response', async () => {
    vaultClient.write.mockResolvedValueOnce({ data: {} });

    await expect(transitDecrypt(client(), args, 'vault:v1:abc')).rejects.toThrow(/returned empty plaintext/);
  });
});

describe('main', () => {
  const run = (...flags: string[]) => main(['tsx', 'decrypt-row.ts', ...flags], { ...process.env, ...VAULT_ENV });
  const ciphertextRow = { id: 'c-1', encryptedContent: Buffer.from('vault:v1:abc', 'utf8') };

  it('prints the decrypted field to stdout, reading with findUnique only, then disconnects', async () => {
    prisma.contextItem.findUnique.mockResolvedValueOnce(ciphertextRow);

    await run('--model', 'contextitem', '--id', 'c-1');

    expect(prisma.contextItem.findUnique).toHaveBeenCalledWith({ where: { id: 'c-1' } });
    expect(stdout).toEqual(['the PHI note']);
    for (const write of ['findMany', 'update', 'delete'] as const) expect(prisma.contextItem[write]).not.toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('emits { model, id, fields } with --json', async () => {
    prisma.contextItem.findUnique.mockResolvedValueOnce(ciphertextRow);

    await run('--model', 'ContextItem', '--id', 'c-1', '--json');

    expect(JSON.parse(stdout.join('\n'))).toEqual({ model: 'ContextItem', id: 'c-1', fields: { content: 'the PHI note' } });
  });

  it('still disconnects when the row does not exist', async () => {
    prisma.contextItem.findUnique.mockResolvedValueOnce(null);

    await expect(run('--model', 'ContextItem', '--id', 'missing')).rejects.toThrow(/ContextItem row not found: missing/);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('reads an AuditLog row through its own delegate', async () => {
    prisma.auditLog.findUnique.mockResolvedValueOnce(null);

    await expect(run('--model', 'auditlog', '--id', 'a-1')).rejects.toThrow(/AuditLog row not found: a-1/);
    expect(prisma.auditLog.findUnique).toHaveBeenCalledWith({ where: { id: 'a-1' } });
  });

  it('refuses to run without SECRETS_PROVIDER=vault, before touching Vault or the database', async () => {
    await main(['tsx', 'decrypt-row.ts', '--model', 'ContextItem', '--id', 'c-1'], { SECRETS_PROVIDER: 'env' });

    expect(process.exitCode).toBe(2);
    expect(stderr.join('\n')).toMatch(/SECRETS_PROVIDER=vault is required/);
    expect(vaultFactory).not.toHaveBeenCalled();
    expect(prisma.contextItem.findUnique).not.toHaveBeenCalled();
  });

  it('prints usage for --help and does nothing else', async () => {
    await run('--help');

    expect(stdout.join('\n')).toMatch(/decrypt-row — READ-ONLY admin\/dev tool/);
    expect(vaultFactory).not.toHaveBeenCalled();
  });
});
