// packages/database/tests/pgbouncer-validation/__tests__/05-discard-all.test.ts
//
// Task 1.11 — Direct telemetry-based verification that PgBouncer is
// actually executing `DISCARD ALL` between assignments (and not just that
// our app code "happens not to leak" — that test is R-RLS-2 in 02-…).
//
// Mechanism: the rig's PostgreSQL runs with `log_statement = 'all'`, so
// every server-side statement (including `DISCARD ALL`, which is issued
// by PgBouncer as `server_reset_query`) appears in the container log.
// We count DISCARD ALL log lines before vs after a burst of N user
// transactions; the delta must be ≥ N (one DISCARD per assignment).
//
// `pg_stat_database.xact_commit` was tried first and rejected: stats
// collector lag (PG18) made the counter underreport real activity for
// short-lived bursts. Log-line counting is authoritative and synchronous.
//
// Phase 1 rubric (per plan §1.18):
//   * R-DA-1 — non-LOCAL GUC set in txn A is gone in txn B (functional)
//   * R-DA-2 — DISCARD ALL log-line Δ in `docker logs pgbv-postgres` is ≥ N

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPooledPrisma } from '../_helpers/clients.ts';

const prisma = createPooledPrisma();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function countDiscardAllInPostgresLog(): number {
  // PostgreSQL logs to stderr; `docker logs` forwards container stderr to
  // local stderr. Merge by spawning a shell that redirects 2>&1.
  const log = execFileSync('sh', ['-c', 'docker logs pgbv-postgres 2>&1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (log.match(/statement: DISCARD ALL/g) ?? []).length;
}

describe('PgBouncer txn-mode — DISCARD ALL between transactions (Task 1.11)', () => {
  it('non-LOCAL GUC set in txn A is gone in txn B (functional)', async () => {
    const tag = 'da1-' + Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.da_marker', '${tag}', false)`);
    });
    // Hammer 20 follow-up txns; if DISCARD ALL didn't fire, at least one
    // backend reuse will surface the marker.
    for (let i = 0; i < 20; i++) {
      const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('app.da_marker', true) AS v`);
      expect(rows[0]?.v ?? '').toBe('');
    }
  });

  it('DISCARD ALL log-line count grows by ≥ N over N user transactions', async () => {
    const N = 40;
    const before = countDiscardAllInPostgresLog();
    console.log(`[Task 1.11] DISCARD ALL count BEFORE burst = ${before}`);

    for (let i = 0; i < N; i++) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT 1');
      });
    }

    // Postgres -> Docker stdout buffering can lag, especially on the first
    // run after a rig recycle (TimescaleDB-HA image has its own startup
    // log-flushing cadence). Poll with a 500ms backoff up to 20s.
    let delta = 0;
    let after = before;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      after = countDiscardAllInPostgresLog();
      delta = after - before;
      if (delta >= N) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(
      `[Task 1.11] DISCARD ALL count AFTER burst  = ${after}; ` +
        `Δ = ${delta} over ${N} user txns ` +
        `(expect ≥ ${N} if server_reset_query_always=1 is enforced)`,
    );

    expect(delta).toBeGreaterThanOrEqual(N);
  }, 25_000);
});
