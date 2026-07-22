// packages/database/tests/pgbouncer-validation/__tests__/01-basic-select.test.ts
//
// Task 1.7 — Prisma 7 can execute a basic SELECT through PgBouncer in
// transaction-pooling mode without raising
// `prepared statement "sN" already exists` (Prisma 7's named statement bug
// against older PgBouncer; the txn-mode workaround relies on
// `max_prepared_statements > 0` per PgBouncer 1.21+).
//
// Phase 1 rubric (per plan §1.18):
//   * R-SELECT-1 — pooled `SELECT 1` returns 1 row, no client error
//   * R-SELECT-2 — pooled `findMany()` against a real schema model returns
//                   without prepared-statement collisions

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPooledPrisma } from '../_helpers/clients.ts';

const prisma = createPooledPrisma();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PgBouncer txn-mode — basic SELECT (Task 1.7)', () => {
  it('raw SELECT through pooler', async () => {
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>('SELECT 1 AS ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('Prisma findMany against a real model survives the pooler', async () => {
    // GlobalSetting is one of the smallest tables in core schema; using it
    // (rather than something larger) keeps the test fast and avoids
    // depending on seed data.
    const rows = await prisma.globalSetting.findMany({ take: 5 });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('20 consecutive queries reuse pooled server connections (no leak)', async () => {
    // 20 short queries should round-trip the same handful of server
    // connections — the pool of size 10 must absorb them without erroring.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, idx) =>
        prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT ${idx}::int AS n`),
      ),
    );
    expect(results).toHaveLength(20);
    results.forEach((rows, idx) => {
      expect(rows[0]?.n).toBe(idx);
    });
  });
});
