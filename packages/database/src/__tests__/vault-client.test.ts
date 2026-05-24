/**
 * Vault-backed PrismaClient factory tests (TASK-302 Phase 5 Task 5.5).
 *
 * Verifies that `getPrismaClientWithVault` and the `VaultPrismaClient`
 * wrapper:
 *   - Fetch a credential from the SecretsService-like dependency.
 *   - Build a pg.Pool with the issued `user` + `password` and the
 *     standard pool-options enforced by Stream C (max, timeouts).
 *   - Pass the Pool to PrismaPg and forward the adapter to PrismaClient.
 *   - Expose `swap()` to rotate the pool with fresh credentials.
 *   - Expose `disconnect()` for graceful pod shutdown.
 *   - NEVER log or persist the credential pair anywhere observable.
 *
 * The pg.Pool + PrismaPg + PrismaClient are mocked; no real DB is hit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaPgMock = vi.fn();
const prismaClientCtorMock = vi.fn();
const prismaDisconnectMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class MockPrismaPg {
    config: unknown;
    constructor(config: unknown) {
      prismaPgMock(config);
      this.config = config;
    }
  },
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    constructor(options: unknown) {
      prismaClientCtorMock(options);
    }
    $connect = vi.fn().mockResolvedValue(undefined);
    $disconnect = prismaDisconnectMock;
    $queryRaw = vi.fn().mockResolvedValue([{ ok: 1 }]);
  },
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    PrismaClientUnknownRequestError: class extends Error {},
    PrismaClientRustPanicError: class extends Error {},
    PrismaClientInitializationError: class extends Error {},
    PrismaClientValidationError: class extends Error {},
  },
}));

vi.mock('../env.js', () => ({}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  prismaPgMock.mockReset();
  prismaClientCtorMock.mockReset();
  prismaDisconnectMock.mockClear();
  prismaDisconnectMock.mockResolvedValue(undefined);
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('getPrismaClientWithVault (Phase 5 Task 5.5)', () => {
  it('fetches a credential from secrets and passes user+password into PrismaPg config', async () => {
    process.env.PG_HOST = 'pgbouncer.internal';
    process.env.PG_PORT = '6432';
    process.env.PG_DATABASE = 'hope_main';

    const requestDbCredential = vi.fn(async (role: string) => ({
      username: `v-token-${role}-1`,
      password: 'super-secret-pw',
      leaseId: 'database/creds/hope-app-role/abc',
      ttlSec: 3600,
    }));
    const secrets = { requestDbCredential };

    const { getPrismaClientWithVault } = await import('../vault-client');
    const client = await getPrismaClientWithVault(secrets, 'hope-app-role');

    expect(client).toBeDefined();
    expect(requestDbCredential).toHaveBeenCalledTimes(1);
    expect(requestDbCredential).toHaveBeenCalledWith('hope-app-role');

    expect(prismaPgMock).toHaveBeenCalledTimes(1);
    const cfg = prismaPgMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg.host).toBe('pgbouncer.internal');
    expect(cfg.port).toBe(6432);
    expect(cfg.database).toBe('hope_main');
    expect(cfg.user).toBe('v-token-hope-app-role-1');
    expect(cfg.password).toBe('super-secret-pw');
  });

  it('honors explicit opts and overrides env vars', async () => {
    process.env.PG_HOST = 'env-host';
    process.env.PG_PORT = '9999';

    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { getPrismaClientWithVault } = await import('../vault-client');
    await getPrismaClientWithVault(secrets, 'hope-app-role', {
      host: 'explicit-host',
      port: 1234,
      database: 'explicit_db',
      max: 12,
    });

    const cfg = prismaPgMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg.host).toBe('explicit-host');
    expect(cfg.port).toBe(1234);
    expect(cfg.database).toBe('explicit_db');
    expect(cfg.max).toBe(12);
  });

  it('applies the same default pool options as Stream C (max=5, timeouts)', async () => {
    delete process.env.PG_HOST;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;

    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { getPrismaClientWithVault } = await import('../vault-client');
    await getPrismaClientWithVault(secrets, 'hope-app-role');

    const cfg = prismaPgMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg.max).toBe(5);
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
    expect(cfg.idleTimeoutMillis).toBe(300_000);
  });

  it('honors PRISMA_PG_MAX env var when set', async () => {
    process.env.PRISMA_PG_MAX = '20';

    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { getPrismaClientWithVault } = await import('../vault-client');
    await getPrismaClientWithVault(secrets, 'hope-app-role');

    const cfg = prismaPgMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg.max).toBe(20);
  });

  it('forwards the constructed adapter into PrismaClient', async () => {
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { getPrismaClientWithVault } = await import('../vault-client');
    await getPrismaClientWithVault(secrets, 'hope-app-role');

    expect(prismaPgMock).toHaveBeenCalledTimes(1);
    expect(prismaClientCtorMock).toHaveBeenCalledTimes(1);
    const adapterArg = prismaClientCtorMock.mock.calls[0]?.[0] as {
      adapter?: { config: unknown };
    };
    expect(adapterArg.adapter).toBeDefined();
    expect(adapterArg.adapter?.config).toBeDefined();
  });
});

describe('VaultPrismaClient class API (Phase 5 Task 5.5)', () => {
  it('exposes the current PrismaClient via `.client`', async () => {
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');

    expect(wrapper.client).toBeDefined();
    expect(wrapper.leaseId).toBe('lid');
    expect(wrapper.ttlSec).toBe(60);
  });

  it('swap() replaces the adapter + client with fresh credentials and schedules the old client for drain', async () => {
    vi.useFakeTimers();
    let counter = 0;
    const secrets = {
      requestDbCredential: vi.fn(async () => {
        counter += 1;
        return {
          username: `v-token-${counter}`,
          password: `pw-${counter}`,
          leaseId: `lid-${counter}`,
          ttlSec: 60,
        };
      }),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');

    expect(wrapper.leaseId).toBe('lid-1');
    expect(prismaPgMock).toHaveBeenCalledTimes(1);

    await wrapper.swap(1_000);

    expect(secrets.requestDbCredential).toHaveBeenCalledTimes(2);
    expect(wrapper.leaseId).toBe('lid-2');
    expect(prismaPgMock).toHaveBeenCalledTimes(2);

    expect(prismaDisconnectMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(prismaDisconnectMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('disconnect() drains the current client and prevents further use', async () => {
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');

    await wrapper.disconnect();
    expect(prismaDisconnectMock).toHaveBeenCalledTimes(1);

    expect(() => wrapper.client).toThrow(/disconnected/i);
  });

  it('disconnect() is idempotent', async () => {
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60,
      })),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');

    await wrapper.disconnect();
    await wrapper.disconnect();

    expect(prismaDisconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('VaultPrismaClient — credential residency Gate 5', () => {
  it('does not log the password during normal operation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const secret = 'top-secret-password-DO-NOT-LEAK';
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u',
        password: secret,
        leaseId: 'lid',
        ttlSec: 60,
      })),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');
    await wrapper.swap();
    await wrapper.disconnect();

    const calls = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ];
    for (const call of calls) {
      const text = typeof call === 'string' ? call : JSON.stringify(call);
      expect(text).not.toContain(secret);
    }

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not stringify the credential when serialised', async () => {
    const secrets = {
      requestDbCredential: vi.fn(async () => ({
        username: 'u',
        password: 'top-secret-pw',
        leaseId: 'lid',
        ttlSec: 60,
      })),
    };

    const { VaultPrismaClient } = await import('../vault-client');
    const wrapper = await VaultPrismaClient.create(secrets, 'hope-app-role');

    const serialised = JSON.stringify(wrapper);
    expect(serialised).not.toContain('top-secret-pw');
  });
});
