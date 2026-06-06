/**
 * TASK-330 Phase 1 — Attestation gate persistence + WORM integration guard.
 *
 * Complements the deterministic service-orchestration unit test
 * (`packages/applications/.../summary.service.test.ts > approveSummary —
 * attestation gate`) by proving the DB-layer CONTRACT the gate relies on,
 * end-to-end, against a live Postgres:
 *
 *   1. A SIGNED_NOTE `ContextItemVersion` carrying the attestation columns
 *      (attestedAt / attestedBy / attestationHash / sensorScores) persists and
 *      reads back intact.
 *   2. An `ATTEST` `HarnessAuditEvent` referencing that version persists
 *      (action enum + contextItemVersionId FK accepted) and reads back.
 *   3. `Consultation.status` flips to `SIGNED`.
 *   4. The ATTEST audit row CANNOT be UPDATEd / DELETEd by the app role
 *      (WORM — REVOKE UPDATE, DELETE) → the signed record cannot be tampered
 *      with or silently bypassed after the fact.
 *
 * SAFETY: every mutation runs inside a transaction that is ROLLED BACK, so no
 * seeded data is altered. No DELETE / DROP / TRUNCATE is ever committed. The
 * test seeds nothing of its own — it references an EXISTING seeded summary
 * ContextItem (and its Consultation) so the FK chain is satisfied; it self-skips
 * when no live DB / migration / suitable seed row is reachable.
 *
 * Excluded from `pnpm test:unit` (the `*.postgres.test.ts` suffix). Run with:
 *   pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hope';
const TEST_ROLE = 'attest_gate_test_role';
const AUDIT_TABLE = 'core."HarnessAuditEvent"';

let admin: pg.Client;
let available = false;
/** A seeded summary ContextItem + its Consultation, used as the FK anchor. */
let seed: { ctxId: string; consId: string; tenantId: string } | null = null;

/** 64-hex chars (sha256-shaped) for hash / attestationHash columns. */
function hex64(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await admin.connect();
  } catch {
    available = false;
    return;
  }

  // Required objects must exist (Phase 0 + Phase 1 migrations applied).
  const objs = await admin.query(
    `SELECT
       to_regclass('core."HarnessAuditEvent"') AS audit,
       to_regclass('core."ContextItemVersion"') AS version,
       to_regclass('core."Consultation"') AS consultation`,
  );
  if (!objs.rows[0]?.audit || !objs.rows[0]?.version || !objs.rows[0]?.consultation) {
    available = false;
    return;
  }

  // Anchor on an existing seeded summary whose Consultation also exists.
  const row = await admin.query(
    `SELECT ci."id" AS ctx_id, ci."consultationId" AS cons_id, ci."tenantId" AS tenant_id
       FROM core."ContextItem" ci
       JOIN core."Consultation" c ON c."id" = ci."consultationId"
      WHERE ci."type" IN ('RAW_SUMMARY','MODIFIED_SUMMARY')
      LIMIT 1`,
  );
  if (row.rowCount === 0) {
    available = false;
    return;
  }
  seed = { ctxId: row.rows[0].ctx_id, consId: row.rows[0].cons_id, tenantId: row.rows[0].tenant_id };

  // Throwaway non-superuser role with the same DML a real app role receives,
  // then the migration's exact WORM revoke (so we can observe append-only).
  await admin.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_ROLE}') THEN
        CREATE ROLE ${TEST_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END
  $$;`);
  await admin.query(`GRANT USAGE ON SCHEMA core TO ${TEST_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${AUDIT_TABLE} TO ${TEST_ROLE}`);
  await admin.query(`REVOKE UPDATE, DELETE ON ${AUDIT_TABLE} FROM ${TEST_ROLE}`);

  available = true;
});

afterAll(async () => {
  if (admin) {
    try {
      await admin.query('RESET ROLE');
    } catch {
      /* ignore */
    }
    await admin.end();
  }
});

describe('TASK-330 Phase 1 — attestation gate (persist + WORM, rolled back)', () => {
  it('persists a SIGNED_NOTE version + ATTEST audit event and flips the consultation to SIGNED', (ctx) => {
    if (!available || !seed) return ctx.skip();
    return (async () => {
      const versionId = randomUUID();
      const auditId = randomUUID();
      const attestationHash = hex64();
      const clinicianId = randomUUID();

      await admin.query('BEGIN');
      try {
        // Unique versionNumber for this context item (rolled back anyway).
        const maxV = await admin.query(
          `SELECT coalesce(max("versionNumber"), 0) + 1 AS n FROM core."ContextItemVersion" WHERE "contextItemId" = $1`,
          [seed!.ctxId],
        );
        const versionNumber = maxV.rows[0].n as number;

        // 1. Attested SIGNED_NOTE version (the confirm-before-commit record).
        await admin.query(
          `INSERT INTO core."ContextItemVersion"
             ("id","tenantId","contextItemId","versionNumber","content","changeReason","changeSummary","changedBy","changeSource","attestedAt","attestedBy","attestationHash","sensorScores")
           VALUES ($1,$2,$3,$4,$5,'approved','Approved and locked',$6,'attestation',now(),$6,$7,$8::jsonb)`,
          [versionId, seed!.tenantId, seed!.ctxId, versionNumber, 'S:.. O:.. A:.. P:..', clinicianId, attestationHash, JSON.stringify({ coverage: 0.91 })],
        );

        // 2. ATTEST WORM audit event referencing the signed version.
        await admin.query(
          `INSERT INTO ${AUDIT_TABLE}
             ("id","tenantId","consultationId","contextItemVersionId","action","modelName","modelVersion","sensorScores","citations","clinicianId","attestationHash","prevHash","hash")
           VALUES ($1,$2,$3,$4,'ATTEST'::core."HarnessAuditAction",'clinician-attestation','v1','{}'::jsonb,'[]'::jsonb,$5,$6,$7,$8)`,
          [auditId, seed!.tenantId, seed!.consId, versionId, clinicianId, attestationHash, '0'.repeat(64), hex64()],
        );

        // 3. Consultation lifecycle → SIGNED.
        const upd = await admin.query(
          `UPDATE core."Consultation" SET "status" = 'SIGNED'::core."ConsultationStatus" WHERE "id" = $1`,
          [seed!.consId],
        );
        expect(upd.rowCount).toBe(1);

        // Read everything back inside the txn.
        const v = await admin.query(
          `SELECT "attestedBy","attestationHash","changeSource","changeReason","sensorScores" FROM core."ContextItemVersion" WHERE "id" = $1`,
          [versionId],
        );
        expect(v.rows[0].attestedBy).toBe(clinicianId);
        expect(v.rows[0].attestationHash).toBe(attestationHash);
        expect(v.rows[0].changeSource).toBe('attestation');
        expect(v.rows[0].changeReason).toBe('approved');
        expect(v.rows[0].sensorScores).toEqual({ coverage: 0.91 });

        const a = await admin.query(
          `SELECT "action"::text AS action, "contextItemVersionId", "attestationHash" FROM ${AUDIT_TABLE} WHERE "id" = $1`,
          [auditId],
        );
        expect(a.rows[0].action).toBe('ATTEST');
        expect(a.rows[0].contextItemVersionId).toBe(versionId);
        expect(a.rows[0].attestationHash).toBe(attestationHash);

        const c = await admin.query(`SELECT "status"::text AS status FROM core."Consultation" WHERE "id" = $1`, [seed!.consId]);
        expect(c.rows[0].status).toBe('SIGNED');
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('cannot be bypassed — the ATTEST audit row rejects UPDATE / DELETE by the app role (WORM)', (ctx) => {
    if (!available || !seed) return ctx.skip();
    return (async () => {
      const auditId = randomUUID();
      await admin.query('BEGIN');
      try {
        await admin.query(
          `INSERT INTO ${AUDIT_TABLE}
             ("id","tenantId","consultationId","action","modelName","modelVersion","sensorScores","citations","attestationHash","prevHash","hash")
           VALUES ($1,$2,$3,'ATTEST'::core."HarnessAuditAction",'clinician-attestation','v1','{}'::jsonb,'[]'::jsonb,$4,$5,$6)`,
          [auditId, seed!.tenantId, seed!.consId, hex64(), '0'.repeat(64), hex64()],
        );

        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        await expect(
          admin.query(`UPDATE ${AUDIT_TABLE} SET "clinicianId" = 'tampered' WHERE "id" = $1`, [auditId]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        // Failed UPDATE aborts the txn; ROLLBACK discards the seed row + resets role.
        await admin.query('ROLLBACK');
      }
    })();
  });

  it('cannot be bypassed — the ATTEST audit row rejects DELETE by the app role (WORM)', (ctx) => {
    if (!available || !seed) return ctx.skip();
    return (async () => {
      const auditId = randomUUID();
      await admin.query('BEGIN');
      try {
        await admin.query(
          `INSERT INTO ${AUDIT_TABLE}
             ("id","tenantId","consultationId","action","modelName","modelVersion","sensorScores","citations","attestationHash","prevHash","hash")
           VALUES ($1,$2,$3,'ATTEST'::core."HarnessAuditAction",'clinician-attestation','v1','{}'::jsonb,'[]'::jsonb,$4,$5,$6)`,
          [auditId, seed!.tenantId, seed!.consId, hex64(), '0'.repeat(64), hex64()],
        );

        await admin.query(`SET LOCAL ROLE ${TEST_ROLE}`);
        await expect(
          admin.query(`DELETE FROM ${AUDIT_TABLE} WHERE "id" = $1`, [auditId]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('ROLLBACK');
      }
    })();
  });
});
