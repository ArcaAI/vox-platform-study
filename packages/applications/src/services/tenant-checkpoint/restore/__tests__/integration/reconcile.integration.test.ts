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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { CheckpointError, type RestorableCategory } from '../../../contracts';
import { sqlQueryOver } from '../../../db/checkpoint-pg';
import { loadFkEdges } from '../../../registry/order';
import { CHECKPOINT_REGISTRY, tableName } from '../../../registry/registry';
import { scopePredicate } from '../../../registry/scope';
import { CheckpointReconciler, type ReconcileArgs, type ReconcileResult } from '../../reconciler';
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

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!.split('?')[0], max: 4 });
    c = await pool.connect();
    modelId = (await one<{ id: string }>(`SELECT id FROM core."AiModel" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [SYSTEM])).id;
    await ensureGuards();
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
        { child: 'Consultation', parent: 'Consultation', column: 'parentConsultationId' },
        { child: 'ContextItem', parent: 'Consultation', column: 'consultationId' },
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
    expect((await one(`SELECT password FROM core."User" WHERE id = $1`, [s.user2])).password).toBe('hash-original');
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

    await restore(cp, A, ['CONFIG_CONTENT']);

    expect((await one(`SELECT name FROM core."Department" WHERE id = $1`, [s.dept])).name).toBe('Cardiology');
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

  it('a full unique key held by a row created after the checkpoint fails closed, naming model and constraint', async () => {
    const s = seeded[A];
    const cp = await checkpointOf(c, A);
    await run(`DELETE FROM core."PromptVersion" WHERE "promptTemplateId" = $1`, [s.tmpl]);
    await run(`DELETE FROM core."PromptTemplate" WHERE id = $1`, [s.tmpl]);
    await run(`INSERT INTO core."PromptTemplate" (id, "tenantId", name, content, category, "updatedAt") VALUES ($1, $2, 'greeting', 'Hi', 'CUSTOM', now())`, [randomUUID(), A]);
    await mark();

    const err = await restore(cp, A, ['CONFIG_CONTENT']).catch((e) => e);

    expect(err).toBeInstanceOf(CheckpointError);
    expect(err.reason).toBe('RESTORE_FAILED');
    expect(err.detail).toMatchObject({ model: 'PromptTemplate', constraint: 'PromptTemplate_tenantId_name_key' });
    expect(err.message).not.toContain('greeting');
    expect(await fingerprintRows(c, A, CAPTURED)).toEqual(before.a);
  });
});
