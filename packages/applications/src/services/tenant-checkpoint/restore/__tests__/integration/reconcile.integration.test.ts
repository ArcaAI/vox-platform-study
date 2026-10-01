/**
 * The restore reconciler against a real PostgreSQL database — the data-loss verdict of tenant
 * checkpoints. Every case asserts the two invariants that matter most:
 *   - another tenant's rows are byte-identical before and after (case 9), and
 *   - the WORM/log tables of the restored tenant are byte-identical (case 7: logs never restored).
 *
 * OPT-IN: `HOPE_INTEG_DB=1`, and run through `vitest.restore.config.ts` in this directory (NOT the
 * root integration config, whose setup truncates every table). The suite owns two throwaway tenant
 * ids and deletes only their rows. The isolated test DB is `db push`-managed, so the Agent
 * immutability triggers and the active-slot partial unique index from the agent migration are
 * installed for the duration of the suite when absent, then removed again.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { CheckpointError, type RestorableCategory } from '../../../contracts';
import { sqlQueryOver } from '../../../db/checkpoint-pg';
import { loadFkEdges } from '../../../registry/order';
import { CHECKPOINT_REGISTRY, tableName } from '../../../registry/registry';
import { scopePredicate } from '../../../registry/scope';
import { CheckpointReconciler, type ReconcileArgs, type ReconcileResult } from '../../reconciler';
import { CLAIM_POST_COMMIT_SQL, restoreBackendName } from '../../restore-row';
import { checkpointOf, fingerprintRows, type TestCheckpoint } from './test-exporter';

const A = '1032a000-0000-4000-8000-000000001032';
const B = '1032b000-0000-4000-8000-000000001032';
const ACTOR = '60000000-0000-0000-0000-000000000000';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

const enabled = process.env.HOPE_INTEG_DB === '1' && !!process.env.DATABASE_URL;

const CAPTURED = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED').map((d) => d.model);
const LOG_MODELS = CHECKPOINT_REGISTRY.filter((d) => d.category === 'LOGS').map((d) => d.model);

const MIGRATION = path.resolve(__dirname, '../../../../../../../database/src/prisma/db_main/migrations/20260904120000_task_863_agent/migration.sql');

interface Seeded {
  dept: string;
  tmpl: string;
  tmplVer: string;
  agentPub: string;
  agentDraft: string;
  role: string;
  user1: string;
  user2: string;
  key0: string;
  key1: string;
  bucket: string;
  consult: string;
  ctx1: string;
  ctx2: string;
  media: string;
}

describe.skipIf(!enabled)('tenant checkpoint restore — reconcile against PostgreSQL (integration)', () => {
  let pool: Pool;
  let c: PoolClient;
  let modelId: string;
  let installedGuards = false;
  const installedIndexes: string[] = [];
  let seeded: Record<string, Seeded>;
  let before: { a: Record<string, string>; b: Record<string, string> };
  const reconciler = new CheckpointReconciler();

  const run = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await c.query(sql, params)).rows[0] as T;

  async function restore(cp: TestCheckpoint, tenantId: string, categories: RestorableCategory[], extra: Partial<ReconcileArgs> = {}): Promise<ReconcileResult> {
    const client = await pool.connect();
    try {
      return await reconciler.reconcile(client, { tenantId, categories, reader: await cp.open(), actorId: ACTOR, restoreId: randomUUID(), ...extra });
    } finally {
      client.release();
    }
  }

  async function cleanup(): Promise<void> {
    await run('BEGIN');
    await run(`SET LOCAL session_replication_role = 'replica'`);
    const parentScoped = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED' && d.scope.kind === 'parent');
    const userScoped = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED' && d.scope.kind === 'tenantMembers');
    const tenantScoped = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED' && d.scope.kind === 'tenantColumn');
    for (const t of [A, B]) {
      for (const d of parentScoped) await run(`DELETE FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`, [t]);
      for (const d of userScoped) await run(`DELETE FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`, [t]);
      for (const d of tenantScoped) await run(`DELETE FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`, [t]);
    }
    await run(`DELETE FROM core."TenantCheckpointRestore" WHERE "tenantId" = ANY($1)`, [[A, B]]);
    await run(`DELETE FROM core."TenantCheckpoint" WHERE "tenantId" = ANY($1)`, [[A, B]]);
    await run(`DELETE FROM core."User" WHERE username LIKE 'l6b-%'`);
    await run(`DELETE FROM core."Role" WHERE name LIKE 'l6b-%'`);
    await run('COMMIT');
  }

  async function seedTenant(t: string): Promise<Seeded> {
    const s: Seeded = {
      dept: randomUUID(), tmpl: randomUUID(), tmplVer: randomUUID(), agentPub: randomUUID(), agentDraft: randomUUID(),
      role: randomUUID(), user1: randomUUID(), user2: randomUUID(), key0: randomUUID(), key1: randomUUID(), bucket: randomUUID(),
      consult: randomUUID(), ctx1: randomUUID(), ctx2: randomUUID(), media: randomUUID(),
    };
    const tag = t.slice(0, 5);
    await run(`INSERT INTO core."Department" (id, "tenantId", name, code, "updatedAt") VALUES ($1, $2, 'Cardiology', 'CARD', now())`, [s.dept, t]);
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'greeting', 'Hello', 'CUSTOM', now())`, [s.tmpl, t]);
    await run(`INSERT INTO core."PromptVersion" (id, "tenantId", "promptTemplateId", "versionNumber", content) VALUES ($1, $2, $3, 1, 'Hello')`, [s.tmplVer, t, s.tmpl]);
    await run(
      `INSERT INTO core."Agent" (id, "tenantId", slug, name, task, "versionNumber", status, "isActive", "modelId", instruction, "publishedAt", "updatedAt")
       VALUES ($1, $2, 'triage', 'Triage', 'TEXT_GENERATION', 1, 'PUBLISHED', true, $3, '{"v":1}', now(), now())`,
      [s.agentPub, t, modelId],
    );
    await run(
      `INSERT INTO core."Agent" (id, "tenantId", slug, name, task, "versionNumber", status, "isActive", "modelId", instruction, "updatedAt")
       VALUES ($1, $2, 'drafty', 'Drafty', 'TEXT_GENERATION', 1, 'DRAFT', true, $3, '{"draft":1}', now())`,
      [s.agentDraft, t, modelId],
    );
    await run(`INSERT INTO core."Role" (id, "tenantId", name, "updatedAt") VALUES ($1, $2, $3, now())`, [s.role, t, `l6b-${tag}-clerk`]);
    for (const [u, name] of [[s.user1, 'one'], [s.user2, 'two']] as const) {
      await run(`INSERT INTO core."User" (id, username, password, "updatedAt") VALUES ($1, $2, 'hash-original', now())`, [u, `l6b-${tag}-${name}`]);
      await run(`INSERT INTO core."UserRoleAssignment" (id, "tenantId", "userId", "roleId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [randomUUID(), t, u, s.role]);
    }
    await run(`INSERT INTO core."UserProfile" (id, "userId", "updatedAt") VALUES ($1, $2, now())`, [randomUUID(), s.user1]);
    for (const k of [s.key0, s.key1]) {
      await run(`INSERT INTO core."ApiKey" (id, "tenantId", "keyName", "keyHash", "keyPrefix", "keyStatus", "updatedAt") VALUES ($1, $2, 'k', $3, 'hk_', 'ACTIVE', now())`, [k, t, `l6b-${k}`]);
    }
    await run(`INSERT INTO core."TenantBucket" (id, "tenantId", name, slug, "bucketType", "updatedAt") VALUES ($1, $2, $3, 'files', 'CUSTOM', now())`, [s.bucket, t, `l6b-${tag}-files`]);
    await run(`INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "updatedAt") VALUES ($1, $2, 'P-1', '2026-10-01', $3, now())`, [s.consult, t, s.user1]);
    for (const ci of [s.ctx1, s.ctx2]) {
      await run(`INSERT INTO core."ContextItem" (id, "tenantId", "consultationId", type, "updatedAt") VALUES ($1, $2, $3, 'WORKNOTE', now())`, [ci, t, s.consult]);
    }
    await run(
      `INSERT INTO core."Media" (id, "tenantId", name, uri, extension, "mimeType", size, hash, "bucketId", "updatedAt") VALUES ($1, $2, 'a.wav', 'audio/a.wav', 'wav', 'audio/wav', 3, 'h', $3, now())`,
      [s.media, t, s.bucket],
    );
    await run(
      `INSERT INTO core."AuditLog" (id, "tenantId", "resourceType", action, data, "previousData", "updatedAt") VALUES ($1, $2, 'Department', 'UPDATE', '{}', '{}', now())`,
      [randomUUID(), t],
    );
    await run(
      `INSERT INTO core."HarnessAuditEvent" (id, "tenantId", action, "modelName", "modelVersion", "sensorScores", citations, "prevHash", hash) VALUES ($1, $2, 'GENERATE', 'm', '1', '{}', '[]', '0', $3)`,
      [randomUUID(), t, `l6b-${randomUUID()}`],
    );
    return s;
  }

  const snapshot = async () => ({ a: await fingerprintRows(c, A, CAPTURED), b: await fingerprintRows(c, B, CAPTURED) });
  const pick = (fp: Record<string, string>, models: readonly string[]) => Object.fromEntries(models.map((m) => [m, fp[m]]));

  async function ensureGuards(): Promise<void> {
    const present = await one<{ i: string | null }>(`SELECT to_regclass('core."Agent_tenant_slug_active_unique"')::text AS i`);
    if (present.i) return;
    const sql = readFileSync(MIGRATION, 'utf8');
    const start = sql.indexOf('CREATE UNIQUE INDEX "Agent_tenant_slug_active_unique"');
    const end = sql.indexOf('-- 4. AgentAssignmentChange is WORM');
    if (start < 0 || end < 0) throw new Error('agent migration markers not found');
    await run(sql.slice(start, end));
    installedGuards = true;
  }

  /** The hand-written partial unique indexes of the migrations (the test DB is `db push`-managed). */
  const PARTIAL_INDEXES: Record<string, string> = {
    AiRoutingPolicy_tenant_task_default_unique: `CREATE UNIQUE INDEX "AiRoutingPolicy_tenant_task_default_unique" ON core."AiRoutingPolicy" ("tenantId", "taskKey") WHERE "isDefault" = true AND "resourceStatus" != 'DELETED'`,
    Consultation_encounterKey_uq: `CREATE UNIQUE INDEX "Consultation_encounterKey_uq" ON core."Consultation" ("tenantId", "patientId", "doctorId", "externalRef") WHERE "externalRef" IS NOT NULL`,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!.split('?')[0], max: 4 });
    c = await pool.connect();
    modelId = (await one<{ id: string }>(`SELECT id FROM core."AiModel" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [SYSTEM])).id;
    await ensureGuards();
    for (const [name, sql] of Object.entries(PARTIAL_INDEXES)) {
      if ((await one<{ i: string | null }>(`SELECT to_regclass('core."${name}"')::text AS i`)).i) continue;
      await run(sql);
      installedIndexes.push(name);
    }
  });

  afterAll(async () => {
    if (!c) return;
    await cleanup();
    if (installedGuards) {
      await run(`DROP TRIGGER IF EXISTS "agent_model_fallback_immutability_guard_trigger" ON core."AgentModelFallback"`);
      await run(`DROP FUNCTION IF EXISTS core."agent_model_fallback_immutability_guard"()`);
      await run(`DROP TRIGGER IF EXISTS "agent_immutability_guard_trigger" ON core."Agent"`);
      await run(`DROP FUNCTION IF EXISTS core."agent_immutability_guard"()`);
      await run(`DROP INDEX IF EXISTS core."Agent_tenant_slug_active_unique"`);
    }
    for (const name of installedIndexes) await run(`DROP INDEX IF EXISTS core."${name}"`);
    c.release();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    seeded = { [A]: await seedTenant(A), [B]: await seedTenant(B) };
  });

  /** Take the "before" fingerprints right before the restore under test. */
  const mark = async () => {
    before = await snapshot();
  };

  afterEach(async () => {
    if (!before) return;
    const after = await snapshot();
    // case 9 — the other tenant is byte-identical in every captured table
    expect(after.b).toEqual(before.b);
    // case 7 — logs are never restored
    expect(pick(after.a, LOG_MODELS)).toEqual(pick(before.a, LOG_MODELS));
    before = undefined as never;
  });

  it('loadFkEdges sees the Consultation self-edge and ContextItem → Consultation on the live schema', async () => {
    const edges = await loadFkEdges(sqlQueryOver(c));
    expect(edges).toEqual(
      expect.arrayContaining([
        { child: 'Consultation', parent: 'Consultation', column: 'parentConsultationId', parentColumn: 'id' },
        { child: 'ContextItem', parent: 'Consultation', column: 'consultationId', parentColumn: 'id' },
      ]),
    );
  });

  it('1 — CONFIG_CONTENT alone: a renamed department comes back, a new template is retired, clinical rows are untouched', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed', "_version" = "_version" + 1 WHERE id = $1`, [s.dept]);
    const newTmpl = randomUUID();
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'later', 'x', 'CUSTOM', now())`, [newTmpl, A]);
    await mark();
    const clinical = pick(before.a, ['Consultation', 'ContextItem', 'Media']);

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Cardiology');
    const t = await one(`SELECT "resourceStatus", "resourceStatusUpdatedBy" FROM core."PromptTemplate" WHERE id = $1`, [newTmpl]);
    expect(t).toEqual({ resourceStatus: 'DELETED', resourceStatusUpdatedBy: ACTOR });
    expect(pick(await fingerprintRows(c, A, ['Consultation', 'ContextItem', 'Media']), ['Consultation', 'ContextItem', 'Media'])).toEqual(clinical);
    expect(res.counts.find((x) => x.model === 'Department')).toMatchObject({ updated: 1, inserted: 0, retired: 0 });
    expect(res.counts.find((x) => x.model === 'PromptTemplate')).toMatchObject({ retired: 1 });
    expect(res.warnings).toEqual([]);
  });

  it('2 — a published Agent created after the checkpoint is soft-deleted and the checkpoint version holds the active slot again', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Agent" SET "isActive" = false, "_version" = "_version" + 1 WHERE id = $1`, [s.agentPub]);
    const v2 = randomUUID();
    await run(
      `INSERT INTO core."Agent" (id, "tenantId", slug, name, task, "versionNumber", status, "isActive", "modelId", instruction, "publishedAt", "updatedAt")
       VALUES ($1, $2, 'triage', 'Triage', 'TEXT_GENERATION', 2, 'PUBLISHED', true, $3, '{"v":2}', now(), now())`,
      [v2, A, modelId],
    );
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT']);

    const rows = (await run(`SELECT id, "isActive", "resourceStatus", status FROM core."Agent" WHERE "tenantId" = $1 AND slug = 'triage' ORDER BY "versionNumber"`, [A])).rows;
    expect(rows).toEqual([
      { id: s.agentPub, isActive: true, resourceStatus: 'ENABLED', status: 'PUBLISHED' },
      { id: v2, isActive: false, resourceStatus: 'DELETED', status: 'PUBLISHED' },
    ]);
  });

  it('2b — swapping which existing version is active does not trip the partial unique mid-statement', async () => {
    const s = seeded[A];
    const v2 = randomUUID();
    await run(
      `INSERT INTO core."Agent" (id, "tenantId", slug, name, task, "versionNumber", status, "isActive", "modelId", instruction, "publishedAt", "updatedAt")
       VALUES ($1, $2, 'triage', 'Triage', 'TEXT_GENERATION', 2, 'PUBLISHED', false, $3, '{"v":2}', now(), now())`,
      [v2, A, modelId],
    );
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Agent" SET "isActive" = false WHERE id = $1`, [s.agentPub]);
    await run(`UPDATE core."Agent" SET "isActive" = true WHERE id = $1`, [v2]);
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT']);

    const rows = (await run(`SELECT id, "isActive" FROM core."Agent" WHERE "tenantId" = $1 AND slug = 'triage' ORDER BY "versionNumber"`, [A])).rows;
    expect(rows).toEqual([
      { id: s.agentPub, isActive: true },
      { id: v2, isActive: false },
    ]);
  });

  it("2c — a fallback added to a published agent after the checkpoint is frozen with it: neither retired nor touched", async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    const fb = randomUUID();
    await run(`INSERT INTO core."AgentModelFallback" (id, "tenantId", "agentId", priority, "modelId", "updatedAt") VALUES ($1, $2, $3, 1, $4, now())`, [fb, A, s.agentPub, modelId]);
    const row = await one(`SELECT f::text AS row FROM core."AgentModelFallback" f WHERE id = $1`, [fb]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect(await one(`SELECT f::text AS row FROM core."AgentModelFallback" f WHERE id = $1`, [fb])).toEqual(row);
    expect(res.counts.find((x) => x.model === 'AgentModelFallback')).toMatchObject({ retired: 0, updated: 0 });
  });

  it('3 — an Agent drafted at checkpoint time and published later with other content is left exactly as it is, with a warning', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Agent" SET instruction = '{"draft":2}', status = 'PUBLISHED', "publishedAt" = now(), "_version" = "_version" + 1 WHERE id = $1`, [s.agentDraft]);
    const live = await one(`SELECT a::text AS row FROM core."Agent" a WHERE id = $1`, [s.agentDraft]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect(await one(`SELECT a::text AS row FROM core."Agent" a WHERE id = $1`, [s.agentDraft])).toEqual(live);
    expect((await one(`SELECT status FROM core."Agent" WHERE id = $1`, [s.agentDraft])).status).toBe('PUBLISHED');
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'IMMUTABLE_DIVERGED', detail: { model: 'Agent', ids: [s.agentDraft] } })]);
  });

  it('4 — an updated row is live _version + 1; a row identical to the checkpoint keeps its _version', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed', "_version" = "_version" + 4 WHERE id = $1`, [s.dept]);
    const deptV = (await one(`SELECT "_version" AS v FROM core."Department" WHERE id = $1`, [s.dept])).v;
    const tmplV = (await one(`SELECT "_version" AS v FROM core."PromptTemplate" WHERE id = $1`, [s.tmpl])).v;
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT "_version" AS v FROM core."Department" WHERE id = $1`, [s.dept])).v).toBe(deptV + 1);
    expect((await one(`SELECT "_version" AS v FROM core."PromptTemplate" WHERE id = $1`, [s.tmpl])).v).toBe(tmplV);
  });

  it('5 — USERS_ACCESS: credentials are never revived, new ones are revoked, users are never rewritten, a deleted member returns', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."ApiKey" SET "keyStatus" = 'REVOKED' WHERE id = $1`, [s.key1]);
    const key2 = randomUUID();
    await run(`INSERT INTO core."ApiKey" (id, "tenantId", "keyName", "keyHash", "keyPrefix", "keyStatus", "updatedAt") VALUES ($1, $2, 'k2', $3, 'hk_', 'ACTIVE', now())`, [key2, A, `l6b-${key2}`]);
    await run(`UPDATE core."User" SET password = 'hash-rotated' WHERE id = $1`, [s.user1]);
    const user1Row = await one(`SELECT u::text AS row FROM core."User" u WHERE id = $1`, [s.user1]);
    const profileRow = await one(`SELECT p::text AS row FROM core."UserProfile" p WHERE "userId" = $1`, [s.user1]);
    await run(`DELETE FROM core."UserRoleAssignment" WHERE "userId" = $1`, [s.user2]);
    await run(`DELETE FROM core."User" WHERE id = $1`, [s.user2]);
    await mark();

    const res = await restore(cp, A, ['USERS_ACCESS']);

    const keys = Object.fromEntries((await run(`SELECT id, "keyStatus" FROM core."ApiKey" WHERE "tenantId" = $1`, [A])).rows.map((r) => [r.id, r.keyStatus]));
    expect(keys).toEqual({ [s.key0]: 'ACTIVE', [s.key1]: 'REVOKED', [key2]: 'REVOKED' });
    expect(await one(`SELECT u::text AS row FROM core."User" u WHERE id = $1`, [s.user1])).toEqual(user1Row);
    expect(await one(`SELECT p::text AS row FROM core."UserProfile" p WHERE "userId" = $1`, [s.user1])).toEqual(profileRow);
    // R1 I-1: the checkpoint never carries a password hash; a re-created user must reset it
    expect((await one(`SELECT password FROM core."User" WHERE id = $1`, [s.user2])).password).toBe('!checkpoint-restore:password-reset-required');
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'USER_REQUIRES_PASSWORD_RESET', detail: { userIds: [s.user2] } }));
    expect((await one(`SELECT count(*)::int AS n FROM core."UserRoleAssignment" WHERE "userId" = $1 AND "tenantId" = $2 AND "roleId" = $3`, [s.user2, A, s.role])).n).toBe(1);
    expect(res.touchedUserIds).toEqual([s.user2]);
  });

  it('6 — CLINICAL: a consultation (and its child) created later is retired, a deleted context item returns', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    const c2 = randomUUID();
    const c3 = randomUUID();
    await run(`INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "updatedAt") VALUES ($1, $2, 'P-2', '2026-10-02', $3, now())`, [c2, A, s.user1]);
    await run(
      `INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "parentConsultationId", "updatedAt") VALUES ($1, $2, 'P-2', '2026-10-03', $3, $4, now())`,
      [c3, A, s.user1, c2],
    );
    await run(`UPDATE core."ContextItem" SET "resourceStatus" = 'DELETED' WHERE id = $1`, [s.ctx1]);
    await mark();

    const res = await restore(cp, A, ['CLINICAL']);

    const status = Object.fromEntries((await run(`SELECT id, "resourceStatus" FROM core."Consultation" WHERE id = ANY($1)`, [[c2, c3, s.consult]])).rows.map((r) => [r.id, r.resourceStatus]));
    expect(status).toEqual({ [c2]: 'DELETED', [c3]: 'DELETED', [s.consult]: 'ENABLED' });
    expect((await one(`SELECT "resourceStatus" FROM core."ContextItem" WHERE id = $1`, [s.ctx1])).resourceStatus).toBe('ENABLED');
    expect([...res.retiredConsultationIds].sort()).toEqual([c2, c3].sort());
  });

  it('8 — a failure in the middle of the transaction leaves zero diff in every table of the tenant', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'later', 'x', 'CUSTOM', now())`, [randomUUID(), A]);
    await run(`UPDATE core."ContextItem" SET "resourceStatus" = 'DELETED' WHERE id = $1`, [s.ctx1]);
    await mark();

    let updates = 0;
    const err = await restore(cp, A, ['CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL'], {
      onStep: ({ phase }) => {
        if (phase === 'update' && ++updates === 3) throw new Error('injected failure after the third model');
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CheckpointError);
    expect(err.reason).toBe('RESTORE_FAILED');
    expect(await fingerprintRows(c, A, CAPTURED)).toEqual(before.a);
  });

  it('10a — schema drift: a checkpoint column the live table no longer has is dropped on the fly', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A, {
      edit: {
        Department: (csv) =>
          csv
            .split('\n')
            .map((line, i) => (line ? `${line},${i === 0 ? 'ghostColumn' : '"boo"'}` : line))
            .join('\n'),
      },
    });
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Cardiology');
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'COLUMN_DROPPED', detail: { model: 'Department', columns: ['ghostColumn'] } }));
  });

  it("10b — a staged row carrying another tenant's id aborts with RESTORE_FAILED and changes nothing", async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A, {
      edit: {
        Department: (csv) => {
          const lines = csv.split('\n').filter(Boolean);
          const forged = lines[1].replace(s.dept, randomUUID()).replace(A, B);
          return [...lines, forged, ''].join('\n');
        },
      },
    });
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);
    await mark();

    const err = await restore(cp, A, ['CONFIG_CONTENT']).catch((e) => e);

    expect(err).toBeInstanceOf(CheckpointError);
    expect(err.reason).toBe('RESTORE_FAILED');
    expect(err.detail).toMatchObject({ model: 'Department' });
    expect(await fingerprintRows(c, A, CAPTURED)).toEqual(before.a);
  });

  it('R2 I-2 — a non-partial unique key held by a row created after the checkpoint: the live row is kept, the claimant (and its child) skipped with a warning', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`DELETE FROM core."PromptVersion" WHERE "promptTemplateId" = $1`, [s.tmpl]);
    await run(`DELETE FROM core."PromptTemplate" WHERE id = $1`, [s.tmpl]);
    const holder = randomUUID();
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'greeting', 'Hi', 'CUSTOM', now())`, [holder, A]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT "resourceStatus", content FROM core."PromptTemplate" WHERE id = $1`, [holder]))).toEqual({ resourceStatus: 'ENABLED', content: 'Hi' });
    expect((await one(`SELECT count(*)::int AS n FROM core."PromptTemplate" WHERE id = $1`, [s.tmpl])).n).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM core."PromptVersion" WHERE id = $1`, [s.tmplVer])).n).toBe(0);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'UNIQUE_SLOT_HELD', detail: { model: 'PromptTemplate', ids: [s.tmpl] } }));
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'PARENT_NOT_RESTORED', detail: { model: 'PromptVersion', ids: [s.tmplVer] } }));
  });

  it('R2 I-2 — a fallback chain replaced after the checkpoint (draft agent): the new row is hard-deleted and the checkpoint row returns', async () => {
    const s = seeded[A];
    const f1 = randomUUID();
    await run(`INSERT INTO core."AgentModelFallback" (id, "tenantId", "agentId", priority, "modelId", "updatedAt") VALUES ($1, $2, $3, 1, $4, now())`, [f1, A, s.agentDraft, modelId]);
    const cp = await checkpointOf(c, A);
    await run(`DELETE FROM core."AgentModelFallback" WHERE id = $1`, [f1]);
    const f3 = randomUUID();
    await run(`INSERT INTO core."AgentModelFallback" (id, "tenantId", "agentId", priority, "modelId", "updatedAt") VALUES ($1, $2, $3, 1, $4, now())`, [f3, A, s.agentDraft, modelId]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    const rows = (await run(`SELECT id, priority, "resourceStatus" FROM core."AgentModelFallback" WHERE "agentId" = $1`, [s.agentDraft])).rows;
    expect(rows).toEqual([{ id: f1, priority: 1, resourceStatus: 'ENABLED' }]);
    expect(res.counts.find((x) => x.model === 'AgentModelFallback')).toMatchObject({ retired: 1, inserted: 1 });
  });

  it('R2 C-2 — a fallback is never inserted under an agent published after the checkpoint', async () => {
    const s = seeded[A];
    const f1 = randomUUID();
    await run(`INSERT INTO core."AgentModelFallback" (id, "tenantId", "agentId", priority, "modelId", "updatedAt") VALUES ($1, $2, $3, 1, $4, now())`, [f1, A, s.agentDraft, modelId]);
    const cp = await checkpointOf(c, A);
    await run(`DELETE FROM core."AgentModelFallback" WHERE id = $1`, [f1]);
    await run(`UPDATE core."Agent" SET instruction = '{"draft":2}', status = 'PUBLISHED', "publishedAt" = now() WHERE id = $1`, [s.agentDraft]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT count(*)::int AS n FROM core."AgentModelFallback" WHERE "agentId" = $1`, [s.agentDraft])).n).toBe(0);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'IMMUTABLE_DIVERGED', detail: { model: 'AgentModelFallback', ids: [f1] } }));
  });

  it('R2 I-1 — draft-then-publish: the diverged new version keeps the active slot; the old version is skipped (SLOT_HELD_BY_DIVERGED), no 23505', async () => {
    const s = seeded[A];
    const v2 = randomUUID();
    await run(
      `INSERT INTO core."Agent" (id, "tenantId", slug, name, task, "versionNumber", status, "isActive", "modelId", instruction, "updatedAt")
       VALUES ($1, $2, 'triage', 'Triage', 'TEXT_GENERATION', 2, 'DRAFT', false, $3, '{"v":2}', now())`,
      [v2, A, modelId],
    );
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Agent" SET "isActive" = false, status = 'DEPRECATED' WHERE id = $1`, [s.agentPub]);
    await run(`UPDATE core."Agent" SET instruction = '{"v":"2b"}', status = 'PUBLISHED', "publishedAt" = now(), "isActive" = true WHERE id = $1`, [v2]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    const rows = (await run(`SELECT id, "isActive", status FROM core."Agent" WHERE "tenantId" = $1 AND slug = 'triage' ORDER BY "versionNumber"`, [A])).rows;
    expect(rows).toEqual([
      { id: s.agentPub, isActive: false, status: 'DEPRECATED' },
      { id: v2, isActive: true, status: 'PUBLISHED' },
    ]);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'SLOT_HELD_BY_DIVERGED', detail: { model: 'Agent', ids: [s.agentPub] } }));
  });

  it('R2 I-1 — default swaps are order-independent: AiRoutingPolicy.isDefault and AiProviderConnection.defaultForProvider', async () => {
    const [p1, p2, c1, c2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // p2 sorts before p1 so the main pass meets the new default first
    const [first, second] = [p1, p2].sort();
    await run(`INSERT INTO core."AiRoutingPolicy" (id, "tenantId", "taskKey", "isDefault", "updatedAt") VALUES ($1, $2, 'text.summary', true, now()), ($3, $2, 'text.summary', false, now())`, [second, A, first]);
    await run(
      `INSERT INTO core."AiProviderConnection" (id, "tenantId", provider, slug, "defaultForProvider", "updatedAt") VALUES ($1, $2, 'openai', 'one', 'openai', now()), ($3, $2, 'openai', 'two', NULL, now())`,
      [c1, A, c2],
    );
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."AiRoutingPolicy" SET "isDefault" = false WHERE id = $1`, [second]);
    await run(`UPDATE core."AiRoutingPolicy" SET "isDefault" = true WHERE id = $1`, [first]);
    await run(`UPDATE core."AiProviderConnection" SET "defaultForProvider" = NULL WHERE id = $1`, [c1]);
    await run(`UPDATE core."AiProviderConnection" SET "defaultForProvider" = 'openai' WHERE id = $1`, [c2]);
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT']);

    const policies = Object.fromEntries((await run(`SELECT id, "isDefault" FROM core."AiRoutingPolicy" WHERE "tenantId" = $1`, [A])).rows.map((r) => [r.id, r.isDefault]));
    expect(policies).toEqual({ [second]: true, [first]: false });
    const conns = Object.fromEntries((await run(`SELECT id, "defaultForProvider" AS d FROM core."AiProviderConnection" WHERE "tenantId" = $1`, [A])).rows.map((r) => [r.id, r.d]));
    expect(conns).toEqual({ [c1]: 'openai', [c2]: null });
  });

  it('R2 I-6 — a retired consultation frees its encounter key; the original is kept in _metadata, the visit can be opened again', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    const c2 = randomUUID();
    await run(
      `INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "externalRef", "_metadata", "updatedAt") VALUES ($1, $2, 'P-9', '2026-10-02', $3, 'VISIT-X', '{"source":"emr"}', now())`,
      [c2, A, s.user1],
    );
    await mark();

    await restore(cp, A, ['CLINICAL']);

    expect(await one(`SELECT "resourceStatus", "externalRef", "_metadata" AS m FROM core."Consultation" WHERE id = $1`, [c2])).toEqual({
      resourceStatus: 'DELETED',
      externalRef: null,
      m: { source: 'emr', retiredExternalRef: 'VISIT-X' },
    });
    await run(
      `INSERT INTO core."Consultation" (id, "tenantId", "patientId", "appointmentDate", "doctorId", "externalRef", "updatedAt") VALUES ($1, $2, 'P-9', '2026-10-02', $3, 'VISIT-X', now())`,
      [randomUUID(), A, s.user1],
    );
  });

  it('R2 I-7 — a CONFIG_CONTENT restore never retires a bucket that live clinical media still points into', async () => {
    const cp = await checkpointOf(c, A);
    const b2 = randomUUID();
    await run(`INSERT INTO core."TenantBucket" (id, "tenantId", name, slug, "bucketType", "updatedAt") VALUES ($1, $2, $3, 'later', 'CUSTOM', now())`, [b2, A, `l6b-1032a-later`]);
    await run(
      `INSERT INTO core."Media" (id, "tenantId", name, uri, extension, "mimeType", size, hash, "bucketId", "updatedAt") VALUES ($1, $2, 'b.wav', 'audio/b.wav', 'wav', 'audio/wav', 3, 'h', $3, now())`,
      [randomUUID(), A, b2],
    );
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT "resourceStatus" FROM core."TenantBucket" WHERE id = $1`, [b2])).resourceStatus).toBe('ENABLED');
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'CROSS_CATEGORY_REFERENCE', detail: { model: 'TenantBucket', ids: [b2] } }));
  });

  it('R1 I-2 — a SUPER_ADMIN assignment is never revived nor retired, even by a platform admin', async () => {
    const s = seeded[A];
    const superAdmin = (await one(`SELECT id FROM core."Role" WHERE name = 'SUPER_ADMIN'`)).id;
    const revoked = randomUUID();
    await run(`INSERT INTO core."UserRoleAssignment" (id, "tenantId", "userId", "roleId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [revoked, A, s.user1, superAdmin]);
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."UserRoleAssignment" SET "resourceStatus" = 'DELETED' WHERE id = $1`, [revoked]);
    const granted = randomUUID();
    await run(`INSERT INTO core."UserRoleAssignment" (id, "tenantId", "userId", "roleId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [granted, A, s.user2, superAdmin]);
    await mark();

    const res = await restore(cp, A, ['USERS_ACCESS'], { platformAdmin: true });

    const status = Object.fromEntries((await run(`SELECT id, "resourceStatus" FROM core."UserRoleAssignment" WHERE id = ANY($1)`, [[revoked, granted]])).rows.map((r) => [r.id, r.resourceStatus]));
    expect(status).toEqual({ [revoked]: 'DELETED', [granted]: 'ENABLED' });
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'ELEVATED_ROLE_UNTOUCHED', detail: { model: 'UserRoleAssignment', ids: [granted, revoked].sort() } }));
  });

  it('R1 I-2 — platform-governed rows (RateLimitRule) are left alone unless a platform admin requested the restore', async () => {
    const cp = await checkpointOf(c, A);
    const rule = randomUUID();
    await run(`INSERT INTO core."RateLimitRule" (id, "tenantId", "routeMatch", "limitValue", "windowMs", active, "updatedAt") VALUES ($1, $2, '/x', 10, 1000, false, now())`, [rule, A]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);
    expect((await one(`SELECT "resourceStatus" FROM core."RateLimitRule" WHERE id = $1`, [rule])).resourceStatus).toBe('ENABLED');
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'PLATFORM_GOVERNED_SKIPPED', detail: { model: 'RateLimitRule', ids: [rule] } }));

    await restore(cp, A, ['CONFIG_CONTENT'], { platformAdmin: true });
    expect((await one(`SELECT "resourceStatus" FROM core."RateLimitRule" WHERE id = $1`, [rule])).resourceStatus).toBe('DELETED');
    before = undefined as never; // two restores in one case: the per-case invariants were checked by the first mark
  });

  it('R1 M-6 — secrets never travel back in time: a rotated key is kept; a NOT NULL secret row is not re-created', async () => {
    const conn = randomUUID();
    const wh = randomUUID();
    await run(`INSERT INTO core."AiProviderConnection" (id, "tenantId", provider, slug, name, "encryptedApiKey", "keyVersion", "updatedAt") VALUES ($1, $2, 'openai', 'k', 'before', 'vault:v1:old', 1, now())`, [conn, A]);
    await run(`INSERT INTO core."WorkflowWebhookSecret" (id, "tenantId", "workflowSlug", "encryptedSecret", "updatedAt") VALUES ($1, $2, 'wf', 'vault:v1:s', now())`, [wh, A]);
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."AiProviderConnection" SET name = 'after', "encryptedApiKey" = 'vault:v2:new', "keyVersion" = 2 WHERE id = $1`, [conn]);
    await run(`DELETE FROM core."WorkflowWebhookSecret" WHERE id = $1`, [wh]);
    await mark();

    const res = await restore(cp, A, ['CONFIG_CONTENT']);

    expect(await one(`SELECT name, convert_from("encryptedApiKey", 'UTF8') AS k, "keyVersion" AS v FROM core."AiProviderConnection" WHERE id = $1`, [conn])).toEqual({
      name: 'before',
      k: 'vault:v2:new',
      v: 2,
    });
    expect((await one(`SELECT count(*)::int AS n FROM core."WorkflowWebhookSecret" WHERE id = $1`, [wh])).n).toBe(0);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'SECRET_REQUIRES_REENTRY', detail: { model: 'WorkflowWebhookSecret', ids: [wh], columns: ['encryptedSecret'] } }));
  });

  it('R2 I-3 — the safety checkpoint is taken from the reconcile snapshot: a row written after it is neither retired nor lost; a retired row is in the safety archive', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    const tNew = randomUUID();
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'later', 'x', 'CUSTOM', now())`, [tNew, A]);
    const lateDept = randomUUID();
    let safety: Awaited<ReturnType<typeof checkpointOf>> | undefined;
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT'], {
      onBegin: async (q) => {
        const [{ id }] = await q<{ id: string }>('SELECT pg_export_snapshot() AS id');
        // a concurrent writer commits after the snapshot
        await run(`INSERT INTO core."Department" (id, "tenantId", name, code, "updatedAt") VALUES ($1, $2, 'Late', 'LATE', now())`, [lateDept, A]);
        const sc = await pool.connect();
        try {
          safety = await checkpointOf(sc, A, { snapshot: id });
        } finally {
          sc.release();
        }
      },
    });

    expect((await one(`SELECT "resourceStatus" FROM core."PromptTemplate" WHERE id = $1`, [tNew])).resourceStatus).toBe('DELETED');
    expect((await one(`SELECT "resourceStatus" FROM core."Department" WHERE id = $1`, [lateDept])).resourceStatus).toBe('ENABLED');
    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Cardiology');
    const reader = await safety!.open();
    const tables: Record<string, string> = {};
    for await (const e of reader.entries()) tables[e.name] = gunzipSync(Buffer.concat(await e.body.toArray())).toString('utf8');
    expect(tables['db/PromptTemplate.csv.gz']).toContain(tNew);
    expect(tables['db/Department.csv.gz']).not.toContain(lateDept);
    before = undefined as never; // the concurrent writer changed tenant A on purpose
  });

  it('R2 I-3 — a concurrent update of a row the restore rewrites fails it as retryable (40001), changing nothing', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);

    const err = await restore(cp, A, ['CONFIG_CONTENT'], {
      onBegin: async (q) => {
        await q('SELECT 1'); // the snapshot is taken
        await run(`UPDATE core."Department" SET name = 'Concurrent' WHERE id = $1`, [s.dept]);
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CheckpointError);
    expect(err).toMatchObject({ reason: 'RESTORE_FAILED', message: 'concurrent write — retry', detail: { model: 'Department', code: '40001' } });
    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Concurrent');
  });

  it('R2 M-1 — a membership restored for a user whose account is deleted is reported', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`DELETE FROM core."UserRoleAssignment" WHERE "userId" = $1`, [s.user2]);
    await run(`UPDATE core."User" SET "resourceStatus" = 'DELETED' WHERE id = $1`, [s.user2]);
    await mark();

    const res = await restore(cp, A, ['USERS_ACCESS']);

    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'USER_DELETED_MEMBERSHIP_RESTORED', detail: { userIds: [s.user2] } }));
  });

  it('R2 M-3 — a restored Media row whose bytes are not in the checkpoint is reported', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Media" SET "resourceStatus" = 'DELETED' WHERE id = $1`, [s.media]);
    await mark();

    const res = await restore(cp, A, ['CLINICAL']);

    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'MEDIA_NOT_CAPTURED', detail: { mediaIds: [s.media] } }));
  });

  /** A TenantCheckpointRestore row of tenant A in `status`. */
  async function restoreRow(status: string): Promise<string> {
    const cpId = randomUUID();
    const id = randomUUID();
    await run(`INSERT INTO core."TenantCheckpoint" (id, "tenantId", label, "updatedAt") VALUES ($1, $2, 'src', now())`, [cpId, A]);
    await run(
      `INSERT INTO core."TenantCheckpointRestore" (id, "tenantId", "checkpointId", reason, "requestedBy", status, "updatedAt") VALUES ($1, $2, $3, 'test restore', $4, $5, now())`,
      [id, A, cpId, ACTOR, status],
    );
    return id;
  }

  it('R2 I-5 — the RECONCILING → POST_COMMIT compare-and-set commits atomically with the data; the reconcile connection is visible to the liveness probe', async () => {
    const s = seeded[A];
    const id = await restoreRow('RECONCILING');
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);
    await mark();
    const seen: Record<string, unknown> = {};

    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('application_name', $1, false)`, [restoreBackendName(id)]);
      await reconciler.reconcile(client, {
        tenantId: A,
        categories: ['CONFIG_CONTENT'],
        reader: await cp.open(),
        actorId: ACTOR,
        restoreId: id,
        beforeCommit: async (q) => {
          seen.claimed = (await q(CLAIM_POST_COMMIT_SQL, [id, null])).length;
          seen.outside = (await one(`SELECT status FROM core."TenantCheckpointRestore" WHERE id = $1`, [id])).status;
          seen.alive = (await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [restoreBackendName(id)])).n;
        },
      });
      await client.query('RESET application_name');
    } finally {
      client.release();
    }

    expect(seen).toEqual({ claimed: 1, outside: 'RECONCILING', alive: 1 });
    expect((await one(`SELECT status FROM core."TenantCheckpointRestore" WHERE id = $1`, [id])).status).toBe('POST_COMMIT');
    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Cardiology');
  });

  it('R2 I-5 — a restore row the sweeper ended after the snapshot makes the compare-and-set fail (40001): nothing commits', async () => {
    const s = seeded[A];
    const id = await restoreRow('RECONCILING');
    const cp = await checkpointOf(c, A);
    await run(`UPDATE core."Department" SET name = 'Renamed' WHERE id = $1`, [s.dept]);
    await mark();

    const err = await restore(cp, A, ['CONFIG_CONTENT'], {
      onBegin: async (q) => {
        await q('SELECT 1');
        await run(`UPDATE core."TenantCheckpointRestore" SET status = 'FAILED', "_version" = "_version" + 1 WHERE id = $1`, [id]); // the sweeper
      },
      beforeCommit: async (q) => {
        await q(CLAIM_POST_COMMIT_SQL, [id, null]);
      },
    }).catch((e) => e);

    expect(err).toMatchObject({ reason: 'RESTORE_FAILED', detail: { code: '40001' } });
    expect((await one(`SELECT status FROM core."TenantCheckpointRestore" WHERE id = $1`, [id])).status).toBe('FAILED');
    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Renamed');
  });

  it('R3 N-3 — the claim stamps heartbeatAt at commit time (clock_timestamp), not at the start of a long transaction', async () => {
    const id = await restoreRow('RECONCILING');
    const cp = await checkpointOf(c, A);
    await mark();

    await restore(cp, A, ['CONFIG_CONTENT'], {
      onBegin: async (q) => {
        await q('SELECT 1'); // the transaction (and now()) starts here
      },
      beforeCommit: async (q) => {
        await q('SELECT pg_sleep(1.5)'); // a long reconcile
        await q(CLAIM_POST_COMMIT_SQL, [id, null]);
      },
    });

    // lag of each stamp behind "now", in the column's own (timestamp without time zone) terms
    const row = await one(
      `SELECT EXTRACT(EPOCH FROM (localtimestamp(3) - "heartbeatAt")) * 1000 AS h, EXTRACT(EPOCH FROM (localtimestamp(3) - "updatedAt")) * 1000 AS u ` +
        `FROM core."TenantCheckpointRestore" WHERE id = $1`,
      [id],
    );
    expect(Number(row.h)).toBeLessThan(1_000);
    expect(Number(row.u)).toBeLessThan(1_000);
  });
});

