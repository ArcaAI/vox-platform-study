// packages/database/tests/pgbouncer-validation/__tests__/08-show-pools-under-load.test.ts
//
// Task 1.16 — capture `SHOW POOLS` mid-load and assert the rubric
// columns are in the expected range.
//
// Phase 1 rubric (per plan §1.18, derived from §17 "Pool sizing decision
// table" and §13 monitoring SLOs):
//   * cl_waiting   = 0   sustained
//   * maxwait      = 0   sustained
//   * sv_active   ≥ 1    during burst (proves connections are checked out)
//   * sv_idle     ≥ min_pool_size after burst settles
//
// The Vitest case fires a brief concurrent burst, snapshots SHOW POOLS
// IN PARALLEL with the burst (so we catch sv_active > 0), and a second
// snapshot AFTER the burst settles to verify the pool drains cleanly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPoolerAdminPg, createPooledPrisma } from '../_helpers/clients.ts';

const prisma = createPooledPrisma();
const admin = createPoolerAdminPg();

interface PoolRow {
  database: string;
  user: string;
  cl_waiting: string;
  sv_active: string;
  sv_idle: string;
  maxwait: string;
  pool_mode: string;
}

async function showPools(): Promise<PoolRow[]> {
  const { rows } = await admin.query<PoolRow>(`SHOW POOLS`);
  return rows.filter((r) => r.database === 'hope' && r.user === 'hope_app');
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await admin.end();
});

describe('PgBouncer txn-mode — SHOW POOLS under load (Task 1.16)', () => {
  it('during a concurrent burst sv_active > 0 and cl_waiting = 0', async () => {
    // Pre-warm the bouncer's server pool to the burst size before
    // measuring. With min_pool_size=5, a cold rig has only 5 idle backends;
    // 40 concurrent clients would briefly queue (cl_waiting > 0) while
    // pgbouncer establishes the additional 35 backends (~5–20 ms each).
    // That queue depth is pool-warm-up behaviour, not a rubric violation.
    // The rubric ("cl_waiting=0 sustained") applies to steady state.
    await Promise.all(Array.from({ length: 40 }, () => prisma.$queryRawUnsafe(`SELECT pg_sleep(0.02)::text AS warmup`)));
    // Brief settle so bouncer-side post-warmup bookkeeping completes.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Launch 40 concurrent transactions that each hold the backend for
    // ~80 ms via pg_sleep, leaving enough overlap to catch SHOW POOLS
    // mid-flight. (`pg_sleep` returns `void`; cast to text so the Prisma
    // adapter-pg deserialiser is happy — `UnsupportedNativeDataType: void`
    // otherwise.)
    const burst = Promise.all(
      Array.from({ length: 40 }, () =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT pg_sleep(0.08)::text AS done`);
        }),
      ),
    );

    // Poll SHOW POOLS while the burst is in flight; record the peak sv_active.
    let peakActive = 0;
    let peakWaiting = 0;
    let maxMaxwait = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const [row] = await showPools();
      if (row) {
        const active = Number(row.sv_active);
        const waiting = Number(row.cl_waiting);
        const wait = Number(row.maxwait);
        if (active > peakActive) peakActive = active;
        if (waiting > peakWaiting) peakWaiting = waiting;
        if (wait > maxMaxwait) maxMaxwait = wait;
      }
      // Tiny pause between polls to not hammer the admin DB.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await burst;

    console.log(`[Task 1.16] burst peak sv_active=${peakActive}, cl_waiting=${peakWaiting}, maxwait=${maxMaxwait}s`);

    expect(peakActive, 'sv_active should peak above 0 during the burst').toBeGreaterThan(0);
    expect(peakWaiting, 'cl_waiting should stay at 0 (default_pool_size=50 > burst=40)').toBe(0);
    expect(maxMaxwait, 'maxwait must stay 0 in healthy pool').toBe(0);
    expect(Number((await showPools())[0]!.pool_mode === 'transaction')).toBe(1);
  });

  it('after the burst settles, sv_idle ≥ min_pool_size (5) and pool_mode=transaction', async () => {
    // Allow the bouncer's idle / reset to fully settle.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const [row] = await showPools();
    expect(row).toBeDefined();
    console.log(`[Task 1.16] post-burst sv_idle=${row!.sv_idle}, sv_active=${row!.sv_active}, ` + `pool_mode=${row!.pool_mode}`);

    expect(Number(row!.sv_idle)).toBeGreaterThanOrEqual(5); // min_pool_size
    expect(row!.pool_mode).toBe('transaction');
  });
});
