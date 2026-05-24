// packages/database/tests/pgbouncer-validation/k6/hope-shape.js
//
// Task 1.15 (OPTIONAL) — application-shape k6 load test for the
// PgBouncer validation rig. Requires a k6 binary built with the
// `xk6-sql` + `xk6-sql-driver-postgres` extensions; see ./README.md.
//
// Workload per VU iteration:
//   1.  read-tx  — BEGIN; set_config app.tenant_id; SELECT … LIMIT 20; COMMIT
//   2.  write-tx — every 10th iteration: UPDATE … resourceStatus
//   3.  audit-tx — every 5th  iteration: INSERT INTO audit
//
// This mirrors the read-heavy / sparse-write pattern of HOPE's
// consultation + audit + tenant_id-scoped queries.

import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';

const POOLED_URL =
  __ENV.DATABASE_URL ||
  'postgres://hope_app:hope_app_local@127.0.0.1:6532/hope?sslmode=disable';

export const options = {
  scenarios: {
    hope_shape: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    sql_query_duration: ['p(95)<200'],
    checks: ['rate>0.99'],
  },
};

const db = sql.open(driver, POOLED_URL);

export function teardown() {
  db.close();
}

export default function () {
  const tenantId = `tenant-${__VU}`;

  // read-tx (every iteration)
  db.exec(`BEGIN`);
  db.exec(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
  db.query(`SELECT id FROM core."GlobalSetting" LIMIT 20`);
  db.exec(`COMMIT`);

  // write-tx (every 10th iteration)
  if (__ITER % 10 === 0) {
    db.exec(`BEGIN`);
    db.exec(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
    db.exec(
      `UPDATE core."GlobalSetting" SET "updatedAt" = NOW() ` +
        `WHERE id IN (SELECT id FROM core."GlobalSetting" LIMIT 1)`,
    );
    db.exec(`COMMIT`);
  }

  // audit-tx (every 5th iteration)
  if (__ITER % 5 === 0) {
    db.exec(`BEGIN`);
    db.exec(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
    db.exec(
      `INSERT INTO core."AuditLog" (id, "actorId", action, "createdAt") ` +
        `VALUES (gen_random_uuid()::text, '${tenantId}', 'k6-load', NOW()) ` +
        `ON CONFLICT DO NOTHING`,
    );
    db.exec(`COMMIT`);
  }
}
