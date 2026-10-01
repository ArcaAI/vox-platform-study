/**
 * The reconcile step of a restore: stage the checkpoint's tables, prove every staged row belongs
 * to the tenant, then retire / update / insert — all inside ONE transaction on one `pg` client.
 * Any failure rolls the whole transaction back: the tenant's tables are left exactly as they were.
 *
 * Phases, across every selected model:
 *   1. stage   — `CREATE TEMP TABLE … (LIKE … INCLUDING DEFAULTS) ON COMMIT DROP` + `COPY FROM STDIN`
 *   2. check   — staged rows outside the tenant ⇒ RESTORE_FAILED; row counts must match the manifest
 *   3. retire  — children first (reverse foreign-key order)
 *   4. update  — parents first; rows whose immutable content diverged are skipped and reported;
 *                a release pass first, so a swapped partial-unique slot never collides mid-statement
 *   5. insert  — parents first
 *
 * A model the checkpoint does not contain is skipped entirely (never "retire everything").
 */
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import {
  CheckpointError,
  type CheckpointArchiveReader,
  type CheckpointModelDescriptor,
  type ReconcileCount,
  type RestorableCategory,
  type RestoreWarning,
} from '../contracts';
import { sqlQueryOver } from '../db/checkpoint-pg';
import { insertOrder, loadFkEdges } from '../registry/order';
import { CHECKPOINT_REGISTRY, descriptorFor, rawTableName, tableName } from '../registry/registry';
import { CsvColumnFilter } from './csv';
import { divergedSql, insertSql, q, retireSql, scopeViolationsSql, stagingTable, updateSql } from './sql';

const WRITING_POLICIES = new Set(['RECONCILE', 'INSERT_ONLY', 'RETIRE_ONLY']);
const ENTRY = /^db\/([A-Za-z_][A-Za-z0-9_]*)\.csv\.gz$/;
const MEMBERSHIP_MODELS = new Set(['UserRoleAssignment', 'UserDepartment']);

export type ReconcilePhase = 'retire' | 'update' | 'insert';

export interface ReconcileArgs {
  tenantId: string;
  categories: readonly RestorableCategory[];
  reader: CheckpointArchiveReader;
  actorId: string;
  restoreId: string;
  /** Called after each model's statement in each phase. Test seam for mid-transaction failure. */
  onStep?: (step: { phase: ReconcilePhase; model: string }) => void | Promise<void>;
}

export interface KnowledgeChunkText {
  chunkIndex: number;
  /** The chunk's Transit ciphertext (`vault:vN:…`), or null when the checkpoint holds none. */
  encryptedText: string | null;
}

export interface ReconcileResult {
  counts: ReconcileCount[];
  warnings: RestoreWarning[];
  touchedUserIds: string[];
  knowledge: { reingest: string[]; retired: string[]; chunks: Record<string, KnowledgeChunkText[]> };
  retiredConsultationIds: string[];
  retiredServiceAccountIds: string[];
}

interface Staged {
  d: CheckpointModelDescriptor;
  /** checkpoint ∩ live columns, checkpoint order */
  columns: string[];
  rows: number;
}

@Injectable()
export class CheckpointReconciler {
  async reconcile(client: PoolClient, args: ReconcileArgs): Promise<ReconcileResult> {
    const { tenantId, actorId } = args;
    const query = sqlQueryOver(client);
    const params = (sql: string) => (sql.includes('$2') ? [tenantId, actorId] : sql.includes('$1') ? [tenantId] : []);
    let where: { phase: string; model: string } = { phase: 'stage', model: '-' };

    const restorable = CHECKPOINT_REGISTRY.filter((d) => (args.categories as readonly string[]).includes(d.category) && WRITING_POLICIES.has(d.policy));
    const derived = CHECKPOINT_REGISTRY.filter(
      (d) => (args.categories as readonly string[]).includes(d.category) && d.derivedFrom && restorable.some((r) => r.model === d.derivedFrom),
    );
    const wanted = new Map([...restorable, ...derived].map((d) => [d.model, d]));

    const result: ReconcileResult = {
      counts: [],
      warnings: [],
      touchedUserIds: [],
      knowledge: { reingest: [], retired: [], chunks: {} },
      retiredConsultationIds: [],
      retiredServiceAccountIds: [],
    };
    const touched = new Set<string>();
    const reingest = new Set<string>();

    await client.query('BEGIN');
    try {
      const live = await liveColumns(query, [...wanted.values()]);
      const staged = new Map<string, Staged>();

      // ---- 1. stage ---------------------------------------------------------------------------
      for await (const entry of args.reader.entries()) {
        const m = ENTRY.exec(entry.name);
        const d = m ? wanted.get(m[1]) : undefined;
        if (!d) continue;
        where = { phase: 'stage', model: d.model };
        if (staged.has(d.model)) throw new CheckpointError('RESTORE_FAILED', `The checkpoint holds ${d.model} twice`, { model: d.model });
        const liveCols = live.get(d.model) ?? [];
        if (!liveCols.length) throw new CheckpointError('RESTORE_FAILED', `Table of ${d.model} no longer exists`, { model: d.model });
        staged.set(d.model, await stageEntry(client, d, entry.body, new Set(liveCols)));
      }
      const manifest = args.reader.manifest();

      // ---- 2. check ---------------------------------------------------------------------------
      const stagedNames = new Set(staged.keys());
      for (const [model, s] of staged) {
        where = { phase: 'check', model };
        const expected = manifest.tables.find((t) => t.model === model)?.rowCount;
        if (expected !== undefined && expected !== s.rows) {
          throw new CheckpointError('RESTORE_FAILED', `${model}: ${s.rows} rows staged, the manifest records ${expected}`, { model });
        }
        const [{ n }] = await query<{ n: number }>(scopeViolationsSql(s.d, stagedNames), [tenantId]);
        if (n > 0) throw new CheckpointError('RESTORE_FAILED', `${model}: ${n} staged row(s) lie outside the tenant`, { model, rows: n });
      }
      for (const d of restorable) {
        if (!staged.has(d.model)) {
          result.warnings.push({
            code: 'MODEL_NOT_IN_CHECKPOINT',
            message: `${d.model} is not in the checkpoint and was left as it is`,
            detail: { model: d.model },
          });
        }
      }

      const order = insertOrder(
        restorable.filter((d) => staged.has(d.model)).map((d) => d.model),
        await loadFkEdges(query),
      );
      const counts = new Map(order.map((m) => [m, { model: m, inserted: 0, updated: 0, retired: 0 }]));

      // ---- 3. retire (children first) -----------------------------------------------------------
      for (const model of [...order].reverse()) {
        where = { phase: 'retire', model };
        const d = descriptorFor(model);
        const sql = retireSql(d, { columns: live.get(model)! });
        if (sql) {
          const res = await client.query(sql + returning(model, 'retire'), params(sql));
          counts.get(model)!.retired += res.rowCount ?? 0;
          collect(model, 'retire', res.rows);
        }
        await args.onStep?.({ phase: 'retire', model });
      }

      // ---- 4. update (parents first) ------------------------------------------------------------
      for (const model of order) {
        where = { phase: 'update', model };
        const { d, columns } = staged.get(model)!;
        const diverged = divergedSql(d, columns);
        if (diverged) {
          const ids = (await query<{ id: string }>(diverged, [tenantId])).map((r) => r.id);
          if (ids.length) {
            result.warnings.push({
              code: 'IMMUTABLE_DIVERGED',
              message: `${model}: ${ids.length} row(s) changed after the checkpoint and are immutable now; they were left as they are`,
              detail: { model, ids },
            });
          }
        }
        for (const sql of [updateSql(d, columns, { release: true }), updateSql(d, columns)]) {
          if (!sql) continue;
          const res = await client.query(sql + returning(model, 'update'), params(sql));
          counts.get(model)!.updated += res.rowCount ?? 0;
          collect(model, 'update', res.rows);
        }
        await args.onStep?.({ phase: 'update', model });
      }

      // ---- 5. insert (parents first) ------------------------------------------------------------
      for (const model of order) {
        where = { phase: 'insert', model };
        const { d, columns } = staged.get(model)!;
        const sql = insertSql(d, columns, stagedNames);
        if (sql) {
          const res = await client.query(sql + returning(model, 'insert'), params(sql));
          counts.get(model)!.inserted += res.rowCount ?? 0;
          collect(model, 'insert', res.rows);
        }
        await args.onStep?.({ phase: 'insert', model });
      }

      // ---- derived: the checkpoint's chunk text of every document to re-ingest -----------------
      const chunkModel = derived.find((d) => d.model === 'KnowledgeChunk');
      if (chunkModel && staged.has(chunkModel.model) && reingest.size) {
        where = { phase: 'knowledge', model: chunkModel.model };
        const rows = await query<{ documentId: string; chunkIndex: number; ct: string | null }>(
          `SELECT s."knowledgeDocumentId" AS "documentId", s."chunkIndex" AS "chunkIndex", convert_from(s."encryptedText", 'UTF8') AS ct ` +
            `FROM ${stagingTable(chunkModel)} s WHERE s."tenantId" = $1 AND s."knowledgeDocumentId" = ANY($2) AND s."resourceStatus" <> 'DELETED' ` +
            `ORDER BY s."knowledgeDocumentId", s."chunkIndex"`,
          [tenantId, [...reingest]],
        );
        for (const r of rows) (result.knowledge.chunks[r.documentId] ??= []).push({ chunkIndex: r.chunkIndex, encryptedText: r.ct });
      }

      await client.query('COMMIT');
      result.counts = order.map((m) => counts.get(m)!);
      result.touchedUserIds = [...touched].sort();
      result.knowledge.reingest = [...reingest].filter((id) => !result.knowledge.retired.includes(id));
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw toRestoreError(error, where);
    }

    function collect(model: string, phase: ReconcilePhase, rows: Record<string, unknown>[]): void {
      if (MEMBERSHIP_MODELS.has(model)) {
        for (const r of rows) for (const k of ['userId', 'oldUserId']) if (typeof r[k] === 'string') touched.add(r[k] as string);
        return;
      }
      const ids = rows.map((r) => r.id as string);
      if (model === 'Consultation' && phase === 'retire') result.retiredConsultationIds.push(...ids);
      if (model === 'ServiceAccount' && phase === 'retire') result.retiredServiceAccountIds.push(...ids);
      if (model === 'KnowledgeDocument') {
        if (phase === 'retire') result.knowledge.retired.push(...ids);
        else ids.forEach((id) => reingest.add(id));
      }
    }
  }
}

/** RETURNING clause for the models whose affected ids feed post-commit work. */
function returning(model: string, phase: ReconcilePhase): string {
  if (MEMBERSHIP_MODELS.has(model)) {
    if (phase === 'update') return ` RETURNING old."userId" AS "oldUserId", new."userId" AS "userId"`;
    return phase === 'insert' ? ` RETURNING "userId"` : ` RETURNING l."userId"`;
  }
  if (model === 'Consultation' || model === 'ServiceAccount' || model === 'KnowledgeDocument') {
    return phase === 'insert' ? ` RETURNING "id"` : ` RETURNING l."id"`;
  }
  return '';
}

async function liveColumns(
  query: ReturnType<typeof sqlQueryOver>,
  descriptors: readonly CheckpointModelDescriptor[],
): Promise<Map<string, string[]>> {
  const byTable = new Map(descriptors.map((d) => [rawTableName(d), d.model]));
  const rows = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'core' AND table_name = ANY($1) AND is_generated <> 'ALWAYS'
      ORDER BY table_name, ordinal_position`,
    [[...byTable.keys()]],
  );
  const out = new Map<string, string[]>(descriptors.map((d) => [d.model, []]));
  for (const r of rows) out.get(byTable.get(r.table_name)!)!.push(r.column_name);
  return out;
}

async function stageEntry(
  client: PoolClient,
  d: CheckpointModelDescriptor,
  body: NodeJS.ReadableStream,
  live: ReadonlySet<string>,
): Promise<Staged> {
  const stg = stagingTable(d);
  await client.query(`CREATE TEMP TABLE ${stg} (LIKE ${tableName(d)} INCLUDING DEFAULTS) ON COMMIT DROP`);
  const filter = new CsvColumnFilter((c) => live.has(c));
  const feeding = pipeline(body, createGunzip(), filter);
  feeding.catch(() => undefined);
  const columns = await Promise.race([filter.kept, feeding.then(() => filter.kept)]);
  if (!columns.includes('id')) throw new CheckpointError('RESTORE_FAILED', `${d.model}: the checkpoint table has no id column`, { model: d.model });
  const copy = client.query(copyFrom(`COPY ${stg} (${columns.map(q).join(', ')}) FROM STDIN (FORMAT csv, HEADER true)`));
  await Promise.all([feeding, pipeline(filter, copy)]);
  await client.query(`ANALYZE ${stg}`);
  return { d, columns, rows: filter.rows };
}

function toRestoreError(error: unknown, where: { phase: string; model: string }): CheckpointError {
  if (error instanceof CheckpointError) return error;
  const pg = error as { code?: string; constraint?: string };
  if (pg?.code === '23505') {
    return new CheckpointError(
      'RESTORE_FAILED',
      `Restoring ${where.model} would violate unique constraint ${pg.constraint ?? '(unknown)'}: a live row created after the checkpoint holds the same key`,
      { model: where.model, phase: where.phase, constraint: pg.constraint ?? null, code: pg.code },
    );
  }
  // Never the driver's message verbatim: a detail line may quote row values.
  const what = pg?.code ? `database error ${pg.code}${pg.constraint ? ` on ${pg.constraint}` : ''}` : (error as Error)?.message ?? String(error);
  return new CheckpointError('RESTORE_FAILED', `Restore failed in the ${where.phase} phase of ${where.model}: ${what}`, {
    model: where.model,
    phase: where.phase,
    ...(pg?.code ? { code: pg.code } : {}),
  });
}
