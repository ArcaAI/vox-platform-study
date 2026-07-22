// packages/database/tests/pgbouncer-validation/__tests__/07-concurrent-rls.test.ts
//
// Task 1.13 — Worst-case concurrency for the RLS GUC isolation guarantee.
//
// 100 simultaneous $transaction calls, each:
//   1. SET LOCAL app.tenant_id = '<unique tag>'
//   2. SELECT current_setting('app.tenant_id', true)
//   3. assert the SELECT returns exactly the tag this txn set
//
// If PgBouncer (or Prisma 7) ever crossed a backend assignment without
// DISCARD ALL or pinning the SET LOCAL to the open transaction, at least
// one txn would observe a foreign tag → test fails.
//
// Phase 1 rubric (per plan §1.18):
//   * R-CRLS-1 — all 100 concurrent txns return their own tag
//   * R-CRLS-2 — zero rejected promises (no pool exhaustion / errors)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPooledPrisma } from '../_helpers/clients.ts';

const prisma = createPooledPrisma();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const N = 100;

describe('PgBouncer txn-mode — 100× concurrent RLS GUC isolation (Task 1.13)', () => {
  it('R-: every concurrent $transaction observes its own tag', async () => {
    const baseTag = `crls-${process.pid}-${Date.now()}-`;

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => {
        const tag = `${baseTag}${i}`;
        return prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT set_config('app.tenant_id', '${tag}', true)`,
          );
          const rows = await tx.$queryRawUnsafe<{ v: string }[]>(
            `SELECT current_setting('app.tenant_id', true) AS v`,
          );
          return { tag, observed: rows[0]?.v ?? '' };
        });
      }),
    );

    const failures = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'rejected');
    if (failures.length > 0) {
      const messages = failures
        .slice(0, 5)
        .map(({ r, i }) => `[${i}] ${(r as PromiseRejectedResult).reason?.message}`);
      console.error('Concurrent RLS failures (first 5):\n  ' + messages.join('\n  '));
    }
    expect(failures, `${failures.length}/${N} txns rejected`).toHaveLength(0);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ tag: string; observed: string }> =>
        r.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(N);

    // Each txn must have observed its own tag — never a sibling's.
    const mismatches = fulfilled
      .map((r, i) => ({ idx: i, ...r.value }))
      .filter((x) => x.observed !== x.tag);
    if (mismatches.length > 0) {
      console.error(
        `RLS GUC LEAK — ${mismatches.length}/${N} txns saw a foreign tag:`,
        mismatches.slice(0, 5),
      );
    }
    expect(mismatches, `${mismatches.length} concurrent txns observed foreign GUC`).toHaveLength(0);
  }, 30_000);
});
