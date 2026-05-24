// TASK-302 Phase 5 Task 5.6 (Stream B) — VaultPrismaFactoryModule.
//
// Unit tests for the pure builder. Spins up no Nest DI; asserts the
// env-toggle branching directly. The downstream VaultPrismaClient is
// stubbed via vi.mock so we don't open real PG connections.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const vaultPrismaCreate = vi.fn();

vi.mock('@arcaai/database', () => ({
  applySoftDeleteExtension: vi.fn((client) => ({ __ext: client })),
  VaultPrismaClient: {
    create: vaultPrismaCreate,
  },
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vaultPrismaCreate.mockReset();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('buildVaultPrismaFactory env-toggle gating', () => {
  it('returns null when SECRETS_PROVIDER is not vault', async () => {
    process.env.SECRETS_PROVIDER = 'env';
    process.env.PG_DYNAMIC_CREDS = 'true';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const fakeSecrets = { requestDbCredential: vi.fn() } as never;
    expect(buildVaultPrismaFactory(fakeSecrets)).toBeNull();
  });

  it('returns null when PG_DYNAMIC_CREDS is not "true"', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'false';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    expect(buildVaultPrismaFactory({} as never)).toBeNull();
  });

  it('returns null when PG_DYNAMIC_CREDS is unset', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    delete process.env.PG_DYNAMIC_CREDS;
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    expect(buildVaultPrismaFactory({} as never)).toBeNull();
  });

  it('returns a callable factory when both toggles are on', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory({} as never);
    expect(factory).toBeInstanceOf(Function);
  });

  it('factory invocation creates VaultPrismaClient with the configured role and returns {client, extendedClient, disconnect}', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    process.env.PG_VAULT_ROLE = 'hope-app-role';

    const disconnectMock = vi.fn(async () => undefined);
    const fakeClient = { $queryRaw: vi.fn() };
    vaultPrismaCreate.mockResolvedValueOnce({
      client: fakeClient,
      disconnect: disconnectMock,
    });

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const fakeSecrets = { requestDbCredential: vi.fn() } as never;
    const factory = buildVaultPrismaFactory(fakeSecrets)!;
    expect(factory).not.toBeNull();
    const result = await factory();

    expect(vaultPrismaCreate).toHaveBeenCalledTimes(1);
    expect(vaultPrismaCreate).toHaveBeenCalledWith(fakeSecrets, 'hope-app-role');
    expect(result.client).toBe(fakeClient);
    expect(result.extendedClient).toEqual({ __ext: fakeClient });
    expect(typeof result.disconnect).toBe('function');

    await result.disconnect();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('honors PG_VAULT_ROLE env override for the role argument', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    process.env.PG_VAULT_ROLE = 'custom-role-name';

    const disconnectMock = vi.fn(async () => undefined);
    vaultPrismaCreate.mockResolvedValueOnce({
      client: {},
      disconnect: disconnectMock,
    });

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory({} as never)!;
    await factory();

    expect(vaultPrismaCreate).toHaveBeenCalledWith({}, 'custom-role-name');
  });
});
