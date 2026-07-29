/**
 * Prisma Client Pool Options Tests
 *
 * Verifies that `createPrismaClient()`
 * constructs the PrismaPg adapter with EXPLICIT pool sizing tuned for HOPE:
 *
 *   max:                      from PRISMA_PG_MAX env (default 5)
 *   connectionTimeoutMillis:  5_000 (5s)
 *   idleTimeoutMillis:        300_000 (5min — long enough to survive the
 *                             keep-alive on PgBouncer + Patroni)
 *
 * These tests mock the PrismaPg constructor and assert the second argument's
 * shape. Real-database behavior is covered by `pool-exhaustion.integration.test.ts`
 * (Task 0.3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaPgMock = vi.fn();

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: prismaPgMock,
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    constructor(_options?: unknown) {}
    $connect = vi.fn().mockResolvedValue(undefined);
    $disconnect = vi.fn().mockResolvedValue(undefined);
    $extends = vi.fn().mockReturnThis();
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
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';
});

afterEach(() => {
  process.env = originalEnv;
});

describe('PrismaPg adapter pool options (Stream C Phase 0)', () => {
  it('passes connectionString, max=5 (default), connectionTimeoutMillis=5000, idleTimeoutMillis=300000', async () => {
    delete process.env.PRISMA_PG_MAX;
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';

    const clientModule = await import('../client');
    clientModule.createNewPrismaClient();

    expect(prismaPgMock).toHaveBeenCalledTimes(1);
    expect(prismaPgMock).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pw@localhost:5432/db',
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 300_000,
    });
  });

  it('honors PRISMA_PG_MAX when set (positive integer)', async () => {
    process.env.PRISMA_PG_MAX = '12';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';

    const clientModule = await import('../client');
    clientModule.createNewPrismaClient();

    expect(prismaPgMock).toHaveBeenCalledTimes(1);
    const call = prismaPgMock.mock.calls[0]?.[0] as { max: number };
    expect(call.max).toBe(12);
  });

  it('throws when PRISMA_PG_MAX is not a positive integer', async () => {
    process.env.PRISMA_PG_MAX = '-3';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';

    const clientModule = await import('../client');

    expect(() => clientModule.createNewPrismaClient()).toThrow(/PRISMA_PG_MAX must be a positive integer/);
  });

  it('throws when PRISMA_PG_MAX is zero', async () => {
    process.env.PRISMA_PG_MAX = '0';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';

    const clientModule = await import('../client');

    expect(() => clientModule.createNewPrismaClient()).toThrow(/PRISMA_PG_MAX must be a positive integer/);
  });

  it('throws when PRISMA_PG_MAX is not a number', async () => {
    process.env.PRISMA_PG_MAX = 'twelve';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db';

    const clientModule = await import('../client');

    expect(() => clientModule.createNewPrismaClient()).toThrow(/PRISMA_PG_MAX must be a positive integer/);
  });

  it('still throws when DATABASE_URL is missing (pre-existing behavior preserved)', async () => {
    delete process.env.DATABASE_URL;

    const clientModule = await import('../client');

    expect(() => clientModule.createNewPrismaClient()).toThrow(/DATABASE_URL environment variable is not set/);
  });
});
