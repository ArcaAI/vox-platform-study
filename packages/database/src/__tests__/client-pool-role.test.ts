/**
 * A gateway process holds SEVERAL `pg.Pool`s, not one. If two of them
 * registered under the same role the pool gauges would read the SUM and an
 * operator would believe one pool was twice as busy as it is; if a pool
 * registered under no role at all, its connections would be invisible while
 * still counting against Postgres' `max_connections`.
 *
 * This pins which role each client factory claims. It mocks the adapter seam
 * rather than connecting, so it needs no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createObservedPgAdapter = vi.fn(() => ({ tag: 'observed-adapter' }));

vi.mock('../pool-observability.js', () => ({
  createObservedPgAdapter,
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: class MockPrismaClient {
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
  vi.resetModules();
  createObservedPgAdapter.mockClear();
  process.env = { ...originalEnv, DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db', PRISMA_PG_MAX: '9' };
});

afterEach(() => {
  process.env = originalEnv;
});

/** The role argument of every adapter this module built, in order. */
async function rolesClaimedBy(use: (m: typeof import('../client.js')) => unknown): Promise<string[]> {
  const module = await import('../client.js');
  use(module);
  return createObservedPgAdapter.mock.calls.map((call) => (call as unknown as [string])[0]);
}

describe('pool roles claimed by the client factories', () => {
  it('labels the tenant-scoped singleton `extended`', async () => {
    expect(await rolesClaimedBy((m) => m.getExtendedPrismaClient())).toEqual(['extended']);
  });

  it('labels the unscoped platform-admin singleton `platform-admin`', async () => {
    expect(await rolesClaimedBy((m) => m.getPlatformAdminPrismaClient_Unscoped())).toEqual(['platform-admin']);
  });

  it('gives the two singletons DISTINCT roles in one process', async () => {
    const module = await import('../client.js');
    module.getExtendedPrismaClient();
    module.getPlatformAdminPrismaClient_Unscoped();
    expect(createObservedPgAdapter.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(['extended', 'platform-admin']);
  });

  it('labels throwaway test/script clients `adhoc` so they cannot pollute the gateway roles', async () => {
    expect(await rolesClaimedBy((m) => m.createNewPrismaClient())).toEqual(['adhoc']);
    createObservedPgAdapter.mockClear();
    expect(await rolesClaimedBy((m) => m.createNewExtendedPrismaClient())).toEqual(['adhoc']);
  });

  it('still hands the adapter the pool size PRISMA_PG_MAX asked for', async () => {
    const module = await import('../client.js');
    module.getExtendedPrismaClient();
    expect(createObservedPgAdapter).toHaveBeenCalledWith('extended', expect.objectContaining({ max: 9, connectionTimeoutMillis: 5_000 }));
  });
});
