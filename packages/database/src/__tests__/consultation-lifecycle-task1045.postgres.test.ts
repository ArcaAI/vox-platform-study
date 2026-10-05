/**
 * Consultation lifecycle simplification — the two migrations, proven against a
 * live Postgres that holds REAL pre-migration data.
 *
 * The status type swap must be correct on a POPULATED table (rows written in
 * the old 12-state vocabulary), and the triggers + partial unique indexes are
 * invisible to `db push` (a dev DB never has them). So this suite does not
 * touch any shared database. It needs a THROWAWAY database whose
 * schema is the migration ledger replayed up to — but not including — the two
 * migrations under test, and it:
 *
 *   1. clones that database into `<name>_t` (CREATE DATABASE … TEMPLATE),
 *   2. writes legacy rows into the clone,
 *   3. executes the COMMITTED `migration.sql` bytes of both migrations,
 *   4. asserts the outcome, and drops the clone.
 *
 * Executing the committed files means weakening the migration fails this suite;
 * a hand-retyped copy of the SQL would not.
 *
 * Excluded from `pnpm test:unit` (the `*.postgres.test.ts` suffix). Run it with
 * the template database's URL in `TASK1045_PRE_URL`:
 *
 *   TASK1045_PRE_URL=postgresql://…/hope_shadow_1045_ab1_pre \
 *     npx vitest run --config vitest.worm.config.ts \
 *     src/__tests__/consultation-lifecycle-task1045.postgres.test.ts
 *
 * Without `TASK1045_PRE_URL` the suite skips — it never falls back to a shared
 * database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const PRE_URL = process.env.TASK1045_PRE_URL;
const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'db_main', 'migrations');

const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

function migrationSql(suffix: string): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith(suffix));
  if (!dir) throw new Error(`migration folder *${suffix} not found`);
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8');
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const describeLive = PRE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture ids
// ---------------------------------------------------------------------------
const T = randomUUID();
const DOCTOR = randomUUID();
const DEPT = randomUUID();

/** Consultation fixtures in the OLD vocabulary, one patient (open key) each. */
const C = {
  open: randomUUID(),
  recording: randomUUID(),
  primed: randomUUID(),
  reopened: randomUUID(),
  draining: randomUUID(),
  draftPending: randomUUID(),
  pendingReview: randomUUID(),
  signed: randomUUID(),
  timedOut: randomUUID(),
  closed: randomUUID(),
  closedComplete: randomUUID(),
  closedIncompleteSystem: randomUUID(),
  closedIncompleteUser: randomUUID(),
};

const OLD_UPDATED_AT = new Date('2026-01-02T03:04:05.000Z');

interface LegacyConsultation {
  id: string;
  status: string;
  patientId: string;
  departmentId?: string | null;
  updatedBy?: string | null;
  metadata?: Record<string, unknown> | null;
  externalRef?: string | null;
  createdAt?: Date;
  resourceStatus?: string;
}

const LEGACY: LegacyConsultation[] = [
  { id: C.open, status: 'OPEN', patientId: 'p-open', metadata: { visitType: 'revisit' } },
  { id: C.recording, status: 'RECORDING', patientId: 'p-recording' },
  { id: C.primed, status: 'PRIMED', patientId: 'p-primed' },
  { id: C.reopened, status: 'REOPENED', patientId: 'p-reopened' },
  { id: C.draining, status: 'DRAINING', patientId: 'p-draining' },
  { id: C.draftPending, status: 'DRAFT_PENDING_SENSORS', patientId: 'p-dps' },
  { id: C.pendingReview, status: 'PENDING_REVIEW', patientId: 'p-pr' },
  { id: C.signed, status: 'SIGNED', patientId: 'p-signed', externalRef: 'EMR-1' },
  { id: C.timedOut, status: 'TIMED_OUT', patientId: 'p-timed-out' },
  { id: C.closed, status: 'CLOSED', patientId: 'p-closed' },
  { id: C.closedComplete, status: 'CLOSED_COMPLETE', patientId: 'p-cc' },
  { id: C.closedIncompleteSystem, status: 'CLOSED_INCOMPLETE', patientId: 'p-ci-sys', updatedBy: 'system' },
  { id: C.closedIncompleteUser, status: 'CLOSED_INCOMPLETE', patientId: 'p-ci-user', updatedBy: 'user-42' },
];

const SIGNED_ITEMS = { transcript: randomUUID(), signedNote: randomUUID() };
const SIGNED_NOTE_VERSION = randomUUID();
const SIGNED_AT = new Date('2026-01-02T01:00:00.000Z');
const ITEM_CREATED_AT = new Date('2026-01-01T10:00:00.000Z');

let admin: pg.Client;
let db: pg.Client;
let scratchName = '';

async function cloneTemplate(templateName: string, target: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
  // A TimescaleDB background worker may hold a session on the template; a
  // template clone needs it to have none.
  for (let attempt = 0; ; attempt += 1) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [templateName]);
    try {
      await admin.query(`CREATE DATABASE "${target}" TEMPLATE "${templateName}"`);
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function seedLegacy(): Promise<void> {
  await db.query(`INSERT INTO core."User" (id, username, password, "updatedAt") VALUES ($1, $2, 'x', now())`, [DOCTOR, `doc-${DOCTOR}`]);
  await db.query(`INSERT INTO core."Department" (id, "tenantId", "updatedAt") VALUES ($1, $2, now())`, [DEPT, T]);
  for (const row of LEGACY) {
    await db.query(
      `INSERT INTO core."Consultation"
         (id, "tenantId", "patientId", "appointmentDate", "doctorId", "departmentId", status, metadata, "externalRef",
          "resourceStatus", "updatedBy", "createdAt", "updatedAt", "_version")
       VALUES ($1, $2, $3, '2026-01-01', $4, $5, $6::core."ConsultationStatus", $7::jsonb, $8,
               $9::core."ResourceStatusType", $10, $11, $12, 3)`,
      [
        row.id,
        T,
        row.patientId,
        DOCTOR,
        row.departmentId === undefined ? DEPT : row.departmentId,
        row.status,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.externalRef ?? null,
        row.resourceStatus ?? 'ENABLED',
        row.updatedBy ?? null,
        row.createdAt ?? new Date('2026-01-01T09:00:00Z'),
        OLD_UPDATED_AT,
      ],
    );
  }
  // The signed consultation: a transcript (v2) and its attested SIGNED_NOTE (v1).
  await db.query(
    `INSERT INTO core."ContextItem" (id, "tenantId", "consultationId", type, "currentVersionNumber", "createdAt", "updatedAt")
     VALUES ($1, $3, $4, 'TRANSCRIPT', 2, $5, now()), ($2, $3, $4, 'SIGNED_NOTE', 1, $5, now())`,
    [SIGNED_ITEMS.transcript, SIGNED_ITEMS.signedNote, T, C.signed, ITEM_CREATED_AT],
  );
  await db.query(
    `INSERT INTO core."ContextItemVersion" (id, "tenantId", "contextItemId", "versionNumber", "attestedAt", "attestedBy", "attestationHash")
     VALUES ($1, $2, $3, 1, $4, 'clinician-7', 'attest-hash-1')`,
    [SIGNED_NOTE_VERSION, T, SIGNED_ITEMS.signedNote, SIGNED_AT],
  );
}

async function consultation(id: string): Promise<Record<string, unknown>> {
  const res = await db.query(`SELECT *, status::text AS status_text FROM core."Consultation" WHERE id = $1`, [id]);
  return res.rows[0];
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  if (!PRE_URL) return;
  const templateName = new URL(PRE_URL).pathname.slice(1);
  scratchName = `${templateName}_t`;
  admin = new pg.Client({ connectionString: withDatabase(PRE_URL, 'postgres') });
  await admin.connect();
  await cloneTemplate(templateName, scratchName);
  db = new pg.Client({ connectionString: withDatabase(PRE_URL, scratchName) });
  await db.connect();

  await seedLegacy();
  await db.query(migrationSql('_task_1045_enum_values'));
  await db.query(migrationSql('_task_1045_consultation_lifecycle'));
}, 120_000);

afterAll(async () => {
  if (db) await db.end();
  if (admin) {
    if (scratchName) await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.end();
  }
});

describeLive('consultation lifecycle migrations', () => {
  it('replaces ConsultationStatus with the seven-state vocabulary', async () => {
    const res = await db.query(`SELECT unnest(enum_range(NULL::core."ConsultationStatus"))::text AS v`);
    expect(res.rows.map((r) => r.v)).toEqual(['OPEN', 'RECORDING', 'PAUSED', 'STOPPED', 'APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE']);
    const def = await db.query(
      `SELECT column_default FROM information_schema.columns WHERE table_schema='core' AND table_name='Consultation' AND column_name='status'`,
    );
    expect(def.rows[0].column_default).toContain("'OPEN'");
  });

  it('adds the new enum values (ContextItemType, HarnessAuditAction, ResourceType)', async () => {
    const values = async (type: string) =>
      (await db.query(`SELECT unnest(enum_range(NULL::core."${type}"))::text AS v`)).rows.map((r) => r.v as string);
    expect(await values('ContextItemType')).toEqual(
      expect.arrayContaining(['TRANSCRIPT_SEGMENT', 'FULL_TRANSCRIPT', 'FACT_LEDGER', 'ENCOUNTER_RECAP']),
    );
    expect(await values('HarnessAuditAction')).toContain('SESSION_APPROVED');
    expect(await values('ResourceType')).toEqual(
      expect.arrayContaining([
        'ConsultationEncounter',
        'ConsultationApproval',
        'ConsultationAttachment',
        'ConsultationFeedback',
        'ConsultationFeedbackRollup',
      ]),
    );
    expect(await values('ConsultationProcessing')).toEqual([
      'IDLE',
      'FINALIZING_TRANSCRIPT',
      'SUMMARIZING',
      'PROCESSING_ATTACHMENT',
      'AWAITING_REVIEW',
      'FAILED',
    ]);
    expect(await values('ConsultationClosedReason')).toEqual(['AUTO', 'MANUAL', 'APPROVED']);
  });

  it.each([
    ['open', 'OPEN'],
    ['recording', 'RECORDING'],
    ['primed', 'OPEN'],
    ['reopened', 'OPEN'],
    ['draining', 'STOPPED'],
    ['draftPending', 'STOPPED'],
    ['pendingReview', 'STOPPED'],
    ['signed', 'APPROVED'],
    ['timedOut', 'CLOSED_INCOMPLETE'],
    ['closed', 'CLOSED_COMPLETE'],
    ['closedComplete', 'CLOSED_COMPLETE'],
    ['closedIncompleteSystem', 'CLOSED_INCOMPLETE'],
    ['closedIncompleteUser', 'CLOSED_INCOMPLETE'],
  ] as const)('the status swap maps a populated %s row → %s', async (key, status) => {
    const row = await consultation(C[key]);
    expect(row.status_text).toBe(status);
    // New columns arrive with their schema defaults; no data backfill (fresh-deploy decision).
    expect(row.processing).toBe('IDLE');
    expect(row.currentEncounterSeq).toBe(1);
    expect(row.reopenCount).toBe(0);
    expect(row.closedReason).toBeNull();
  });

  describe('partial unique indexes', () => {
    async function insertConsultation(status: string, patientId: string, departmentId: string | null = DEPT): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "departmentId", status, "updatedAt")
         VALUES ($1, $2, $3, '2026-02-01', $4, $5, $6::core."ConsultationStatus", now())`,
        [id, T, patientId, DOCTOR, departmentId, status],
      );
      return id;
    }

    it('Consultation_openKey_uq: one non-closed consultation per open key; closed rows repeat freely', async () => {
      await expectCode(insertConsultation('STOPPED', 'p-open'), UNIQUE_VIOLATION);
      await expect(insertConsultation('CLOSED_INCOMPLETE', 'p-open')).resolves.toBeTypeOf('string');
      await expect(insertConsultation('CLOSED_COMPLETE', 'p-open')).resolves.toBeTypeOf('string');
      await insertConsultation('OPEN', 'p-null-key', null);
      await expectCode(insertConsultation('PAUSED', 'p-null-key', null), UNIQUE_VIOLATION);
    });

    it('ConsultationEncounter_externalRef_uq: a ref names one encounter per consultation; null refs repeat', async () => {
      const insert = (seq: number, ref: string | null) =>
        db.query(
          `INSERT INTO core."ConsultationEncounter" (id, "tenantId", "consultationId", seq, "visitType", "externalRef", "updatedAt")
           VALUES ($1, $2, $3, $4, 'revisit', $5, now())`,
          [randomUUID(), T, C.open, seq, ref],
        );
      await insert(2, null);
      await insert(3, null);
      await insert(4, 'EMR-9');
      await expectCode(insert(5, 'EMR-9'), UNIQUE_VIOLATION);
      await expectCode(insert(4, 'EMR-10'), UNIQUE_VIOLATION); // (consultationId, seq) unique
    });

    async function insertItem(type: string, extra: { segmentKey?: string; encounterSeq?: number; deleted?: boolean } = {}) {
      return db.query(
        `INSERT INTO core."ContextItem" (id, "tenantId", "consultationId", type, "segmentKey", "encounterSeq", "resourceStatus", "updatedAt")
         VALUES ($1, $2, $3, $4::core."ContextItemType", $5, $6, $7::core."ResourceStatusType", now())`,
        [randomUUID(), T, C.recording, type, extra.segmentKey ?? null, extra.encounterSeq ?? null, extra.deleted ? 'DELETED' : 'ENABLED'],
      );
    }

    it('ContextItem_segmentKey_uq: segment ingest is idempotent per key', async () => {
      await insertItem('TRANSCRIPT_SEGMENT', { segmentKey: 'sess-1:0' });
      await insertItem('TRANSCRIPT_SEGMENT', { segmentKey: 'sess-1:1' });
      await expectCode(insertItem('TRANSCRIPT_SEGMENT', { segmentKey: 'sess-1:0' }), UNIQUE_VIOLATION);
    });

    it('ContextItem_fullTranscript_uq: one live FULL_TRANSCRIPT per consultation', async () => {
      await insertItem('FULL_TRANSCRIPT', { deleted: true });
      await insertItem('FULL_TRANSCRIPT');
      await expectCode(insertItem('FULL_TRANSCRIPT'), UNIQUE_VIOLATION);
    });

    it('ContextItem_encounterArtifact_uq: one live ledger / recap per encounter', async () => {
      await insertItem('FACT_LEDGER', { encounterSeq: 1 });
      await insertItem('FACT_LEDGER', { encounterSeq: 2 });
      await insertItem('ENCOUNTER_RECAP', { encounterSeq: 1 });
      await expectCode(insertItem('FACT_LEDGER', { encounterSeq: 1 }), UNIQUE_VIOLATION);
      await expectCode(insertItem('ENCOUNTER_RECAP', { encounterSeq: 1 }), UNIQUE_VIOLATION);
    });

    it('ConsultationFeedback_latest_uq: one latest rating per (tenant, actor, target)', async () => {
      const insert = (isLatest: boolean, rating: string | null) =>
        db.query(
          `INSERT INTO core."ConsultationFeedback" (id, "tenantId", "consultationId", "actorUserId", "actorCredentialClass", "targetKey", rating, "isLatest")
           VALUES ($1, $2, $3, 'u-1', 'jwt', 'NOTE|item|1||', $4::core."FeedbackRating", $5)`,
          [randomUUID(), T, C.open, rating, isLatest],
        );
      await insert(true, 'UP');
      await insert(false, 'DOWN');
      await insert(true, null);
      await expectCode(insert(true, 'DOWN'), UNIQUE_VIOLATION);
    });
  });

  describe('immutability triggers', () => {
    it('ContextItemVersion: a real UPDATE raises, a no-op UPDATE is tolerated, DELETE raises', async () => {
      await expectCode(
        db.query(`UPDATE core."ContextItemVersion" SET "changeReason" = 'retcon' WHERE id = $1`, [SIGNED_NOTE_VERSION]),
        RESTRICT_VIOLATION,
      );
      await expect(
        db.query(`UPDATE core."ContextItemVersion" SET "changeReason" = "changeReason" WHERE id = $1`, [SIGNED_NOTE_VERSION]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expectCode(db.query(`DELETE FROM core."ContextItemVersion" WHERE id = $1`, [SIGNED_NOTE_VERSION]), RESTRICT_VIOLATION);
    });

    it('ConsultationApproval: INSERT works, UPDATE and DELETE both raise', async () => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO core."ConsultationApproval" (id, "tenantId", "consultationId", "approvedBy", "consultationVersion", "encounterCount", snapshot, "snapshotHash")
         VALUES ($1, $2, $3, 'clinician-7', 3, 1, '{"items":[]}'::jsonb, 'h')`,
        [id, T, C.signed],
      );
      await expectCode(db.query(`UPDATE core."ConsultationApproval" SET "attestationHash" = 'x' WHERE id = $1`, [id]), RESTRICT_VIOLATION);
      await expectCode(db.query(`DELETE FROM core."ConsultationApproval" WHERE id = $1`, [id]), RESTRICT_VIOLATION);
    });
  });

  it('creates the attachment, feedback-rollup and run-record tables', async () => {
    const res = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='core'
         AND table_name IN ('ConsultationAttachment','ConsultationFeedback','ConsultationFeedbackDailyRollup','AiActivityRun')`,
    );
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'AiActivityRun',
      'ConsultationAttachment',
      'ConsultationFeedback',
      'ConsultationFeedbackDailyRollup',
    ]);
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='core' AND table_name='SummaryMeta'
         AND column_name IN ('coverageStatus','coverageGapCount','encryptedCoverageReport','budgetStrategy','noteInputDigest')`,
    );
    expect(cols.rows).toHaveLength(5);
  });
});
