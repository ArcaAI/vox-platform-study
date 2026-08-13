// packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts
//
// Task 1.8 — Most critical txn-mode safety test.
//
// In transaction-mode pooling, a server backend is returned to the pool at
// the end of every transaction. If a previous client set a session GUC
// (e.g. `SET app.tenant_id = 'tenant-a'` without LOCAL) and the bouncer
// hands that backend to a NEW client without running DISCARD ALL, the new
// client's first query would silently inherit `tenant-a` — a catastrophic
// multi-tenancy leak when RLS policies key on `current_setting('app.tenant_id')`.
//
// Mitigations under test:
//   1. `SET LOCAL` (Postgres-native) is auto-cleared at COMMIT/ROLLBACK
//   2. `server_reset_query = DISCARD ALL` + `server_reset_query_always = 1`
//      (Compose-configured) wipes non-LOCAL settings between assignments
//   3. Together: no GUC leak across `$transaction` boundaries
//
// Phase 1 rubric:
//   * R-RLS-1 — SET LOCAL inside $transaction is visible only inside it
//   * R-RLS-2 — Even SET (non-LOCAL) is wiped between assignments (DISCARD ALL)
//   * R-RLS-3 — 30 sequential transactions never see a leaked tenant_id

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPooledPrisma } from '../_helpers/clients.ts';

const prisma = createPooledPrisma();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PgBouncer txn-mode — RLS GUC leak (Task 1.8)', () => {
  it('SET LOCAL via set_config(..., true) is visible only inside the same txn', async () => {
    const tag = 'tenant-rls1-' + Date.now();

    // Inside the txn — must observe the tag.
    const inside = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.tenant_id', '${tag}', true)`);
      const rows = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.tenant_id', true) AS v`);
      return rows[0]?.v;
    });
    expect(inside).toBe(tag);

    // After the txn — must be cleared (empty string per current_setting(..., true) when missing-OK).
    const after = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.tenant_id', true) AS v`);
    expect(after[0]?.v ?? '').toBe('');
  });

  it('even non-LOCAL set_config is wiped between assignments (DISCARD ALL)', async () => {
    const tag = 'tenant-rls2-' + Date.now();

    // Deliberately use is_local=false to simulate buggy app code that uses SET (not SET LOCAL).
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.tenant_id', '${tag}', false)`);
    });

    // Burn through 20 follow-up txns; at least one is statistically guaranteed
    // to land on the same backend (pool size is 10). If DISCARD ALL is NOT
    // firing, at least one of these will see `tag` instead of ''.
    const observed = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.tenant_id', true) AS v`);
      observed.add(rows[0]?.v ?? '');
    }
    expect(observed.has(tag)).toBe(false);
    expect([...observed]).toEqual(['']);
  });

  it('30 sequential $transaction iterations — each starts with empty tenant_id, sets its own', async () => {
    for (let i = 0; i < 30; i++) {
      const tag = `tenant-rls3-${i}`;
      const result = await prisma.$transaction(async (tx) => {
        const before = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.tenant_id', true) AS v`);
        await tx.$queryRawUnsafe(`SELECT set_config('app.tenant_id', '${tag}', true)`);
        const after = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.tenant_id', true) AS v`);
        return { before: before[0]?.v ?? '', after: after[0]?.v ?? '' };
      });
      // The "before" check is the critical anti-leak assertion: any backend
      // we land on must be cleansed before our txn starts running.
      expect(result.before, `iteration ${i} saw leaked GUC`).toBe('');
      expect(result.after).toBe(tag);
    }
  });
});
