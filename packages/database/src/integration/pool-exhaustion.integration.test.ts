/**
 * Pool Exhaustion Integration Test
 *
 * Real-database verification that the
 * PrismaPg adapter rejects connection acquisition once the pool is saturated.
 *
 * Constraints under test:
 *   - PRISMA_PG_MAX = 2  → only 2 backends per pool
 *   - connectionTimeoutMillis = 5_000  → 3rd waiter rejects within 5s
 *
 * Prerequisites:
 *   1. Start test infrastructure: pnpm docker:test:up
 *   2. Push schema:               pnpm test:db:push
 *   3. Run:                       pnpm test:integration
 *
 * The integration vitest config (`vitest.integration.config.ts`) loads the
 * global setup at `tests/setup/integration.setup.ts`, which validates
 * NODE_ENV=test and DATABASE_URL points at the test PG.
 *
 * Note on `pg_sleep`: we use 10 seconds (intentionally longer than the
 * 5_000 ms `connectionTimeoutMillis`) so the third waiter deterministically
 * exceeds the timeout while the first two backends are still held. The plan
 * text mentions "1 s pg_sleep" — that would NOT trigger the timeout
 * (a backend would free up in 1 s, well within the 5 s budget); the test
 * therefore uses a sleep longer than the timeout per the assertion's intent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createNewPrismaClient, type CorePrismaClient } from '../client';

const POOL_MAX = 2;
const CONN_TIMEOUT_MS = 5_000;
const HOLD_SECONDS = 10;

describe('PrismaPg adapter — pool exhaustion (Stream C Phase 0)', () => {
  const created: CorePrismaClient[] = [];

  afterEach(async () => {
    while (created.length > 0) {
      const c = created.pop();
      try {
        await c?.$disconnect();
      } catch {
        /* ignore: test teardown best-effort */
      }
    }
  });

  function makeClient(maxOverride: number): CorePrismaClient {
    const prev = process.env.PRISMA_PG_MAX;
    process.env.PRISMA_PG_MAX = String(maxOverride);
    try {
      const client = createNewPrismaClient();
      created.push(client);
      return client;
    } finally {
      if (prev === undefined) {
        delete process.env.PRISMA_PG_MAX;
      } else {
        process.env.PRISMA_PG_MAX = prev;
      }
    }
  }

  it(`rejects the third concurrent acquire within ${CONN_TIMEOUT_MS} ms when PRISMA_PG_MAX=${POOL_MAX}`, async () => {
    const prisma = makeClient(POOL_MAX);
    await prisma.$connect();

    // Saturate the pool with two long-running queries (pg_sleep > timeout).
    // Important: Prisma returns a *lazy* PrismaPromise; it does not actually
    // dispatch the query until .then()/.catch() is called. We attach .catch()
    // to start execution AND to swallow the eventual abort/disconnect error.
    const hold1 = prisma.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_SECONDS})`).then(
      () => undefined,
      () => undefined,
    );
    const hold2 = prisma.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_SECONDS})`).then(
      () => undefined,
      () => undefined,
    );

    // Give pg-pool a moment to actually check out both backends before the third arrives.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The third concurrent acquire must reject within the connection timeout.
    const start = Date.now();
    let thirdError: unknown;
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (error) {
      thirdError = error;
    }
    const elapsed = Date.now() - start;

    // Free up the long-running queries: disconnecting cancels in-flight statements.
    void hold1;
    void hold2;
    await prisma.$disconnect();
    // Pop the manually-disconnected client off the cleanup stack so afterEach doesn't
    // try to $disconnect() a stale handle.
    const idx = created.indexOf(prisma);
    if (idx >= 0) created.splice(idx, 1);

    expect(thirdError, 'third query must reject when pool is saturated').toBeDefined();
    // pg adapter surface for timeout: a wrapping Error whose message contains
    // "timeout exceeded when trying to connect" (node-pg) or a Prisma wrap of
    // the same. We match generically.
    const msg = String((thirdError as Error)?.message ?? thirdError);
    expect(msg).toMatch(/timeout|connect/i);

    // The rejection should happen close to the configured timeout, not earlier
    // (premature reject) and not way later (no enforcement). 1.5× ceiling
    // accommodates event-loop jitter / Docker overhead.
    expect(elapsed).toBeGreaterThanOrEqual(CONN_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThanOrEqual(CONN_TIMEOUT_MS * 1.5 + 2_000);
  }, 20_000); // Vitest test timeout: must exceed CONN_TIMEOUT_MS plus some margin.

  it(`accepts a second acquire concurrently when PRISMA_PG_MAX=${POOL_MAX} (sanity check)`, async () => {
    const prisma = makeClient(POOL_MAX);
    await prisma.$connect();

    const start = Date.now();
    const [a, b] = await Promise.all([
      prisma.$queryRawUnsafe<{ x: number }[]>('SELECT 1 AS x'),
      prisma.$queryRawUnsafe<{ x: number }[]>('SELECT 2 AS x'),
    ]);
    const elapsed = Date.now() - start;

    expect(a[0]?.x).toBe(1);
    expect(b[0]?.x).toBe(2);
    // Two concurrent SELECTs should resolve quickly (well under the timeout).
    expect(elapsed).toBeLessThan(CONN_TIMEOUT_MS);
  }, 10_000);
});
