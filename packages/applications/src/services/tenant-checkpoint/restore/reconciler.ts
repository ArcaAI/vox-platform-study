/**
 * The reconcile step of a restore: stage the checkpoint's tables, prove every staged row belongs
 * to the tenant, plan which rows the restore must leave alone, then retire / update / insert — all
 * inside ONE `REPEATABLE READ` transaction on one `pg` client. Any failure rolls the whole
 * transaction back: the tenant's tables are left exactly as they were. A concurrent write the
 * snapshot cannot serialise against (40001) fails the restore as retryable.
 *
 * Phases, across every selected model:
 *   0. begin   — `BEGIN ISOLATION LEVEL REPEATABLE READ`; `onBegin` runs first (the runner exports
 *                this snapshot and takes the SAFETY checkpoint from it, so the safety archive holds
 *                every row this transaction can retire)
 *   1. stage   — `CREATE TEMP TABLE … (LIKE … INCLUDING DEFAULTS) ON COMMIT DROP` + `COPY FROM STDIN`
 *   2. check   — staged rows outside the tenant ⇒ RESTORE_FAILED; row counts must match the manifest
 *   3. plan    — per model, `keep_<Model>` (live rows never touched) and `skip_<Model>` (staged rows
 *                never written): elevated-role assignments, platform-governed rows, immutable
 *                divergence, cross-category references, frozen inserts, held unique/single slots,
 *                NOT NULL secrets that cannot be re-entered
 *   4. retire  — children first (reverse foreign-key order)
 *   5. update  — parents first; a release pass first, so a swapped single-holder slot never collides
 *   6. insert  — parents first; a row whose staged parent was not restored is skipped
 *
 * A model the checkpoint does not contain is skipped entirely (never "retire everything").
 */
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { parseStorageUri } from '../../../common/storage-uri';
import {
  CheckpointError,
  RESTORABLE_CATEGORIES,
  type CheckpointArchiveReader,
  type CheckpointModelDescriptor,
  type ReconcileCount,
  type RestorableCategory,
  type RestoreWarning,
  type SqlQuery,
} from '../contracts';
import { sqlQueryOver } from '../db/checkpoint-pg';
import { insertOrder, loadFkEdges } from '../registry/order';
import { CHECKPOINT_REGISTRY, descriptorFor, rawTableName, tableName } from '../registry/registry';
import { CsvColumnFilter } from './csv';
import {
  affectedMatchingSql,
  crossCategoryReferencedSql,
  differingRowsSql,
  divergedSql,
  frozenInsertSql,
  insertCandidatesSql,
  insertSql,
  keepTable,
  matchingRowsSql,
  neverWrittenColumns,
  orphanInsertsSql,
  q,
  releaseDeletedMarkersSql,
  retireSql,
  scopeViolationsSql,
  skipTable,
  slotClaimantsSql,
  stagingTable,
  uniqueClaimantsSql,
  updateSql,
} from './sql';

const WRITING_POLICIES = new Set(['RECONCILE', 'INSERT_ONLY', 'RETIRE_ONLY']);
const ENTRY = /^db\/([A-Za-z_][A-Za-z0-9_]*)\.csv\.gz$/;
const MEMBERSHIP_MODELS = new Set(['UserRoleAssignment', 'UserDepartment']);
/** Models whose affected ids feed post-commit work or a warning. */
const ID_MODELS = new Set(['Consultation', 'ServiceAccount', 'KnowledgeDocument', 'User']);

export type ReconcilePhase = 'retire' | 'update' | 'insert';

export interface ReconcileArgs {
  tenantId: string;
  categories: readonly RestorableCategory[];
  reader: CheckpointArchiveReader;
  actorId: string;
  restoreId: string;
  /** The restore was requested by a platform admin: platform-governed rows are restored too. */
  platformAdmin?: boolean;
  /** Runs right after BEGIN, before anything else reads: the place to export this snapshot. */
  onBegin?: (query: SqlQuery) => Promise<void>;
  /** Called after each model's statement in each phase. Test seam for mid-transaction failure. */
  onStep?: (step: { phase: ReconcilePhase; model: string }) => void | Promise<void>;
  /** Last statement(s) before COMMIT, on the reconcile connection; throwing rolls everything back. */
  beforeCommit?: (query: SqlQuery) => Promise<void>;
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

interface LiveTable {
  columns: string[];
  /** NOT NULL columns with no default (an insert must supply them). */
  required: Set<string>;
}

interface Staged {
  d: CheckpointModelDescriptor;
  /** checkpoint ∩ live columns, checkpoint order */
  columns: string[];
  /** checkpoint columns the live table no longer has */
  dropped: string[];
  rows: number;
}

@Injectable()
export class CheckpointReconciler {
  async reconcile(client: PoolClient, args: ReconcileArgs): Promise<ReconcileResult> {
    const { tenantId, actorId } = args;
    const selected = args.categories as readonly string[];
    const query = sqlQueryOver(client);
    const params = (sql: string) => (sql.includes('$2') ? [tenantId, actorId] : sql.includes('$1') ? [tenantId] : []);
    let where: { phase: string; model: string } = { phase: 'begin', model: '-' };

    const restorable = CHECKPOINT_REGISTRY.filter((d) => selected.includes(d.category) && WRITING_POLICIES.has(d.policy));
    const derived = CHECKPOINT_REGISTRY.filter((d) => selected.includes(d.category) && d.derivedFrom && restorable.some((r) => r.model === d.derivedFrom));
    const wanted = new Map([...restorable, ...derived].map((d) => [d.model, d]));

    const result: ReconcileResult = {
      counts: [],
      warnings: [],
      touchedUserIds: [],
      knowledge: { reingest: [], retired: [], chunks: {} },
      retiredConsultationIds: [],
      retiredServiceAccountIds: [],
    };
    const warn = (code: string, message: string, detail: Record<string, unknown>) => result.warnings.push({ code, message, detail });
    const touched = new Set<string>();
    const reingest = new Set<string>();
    const revivedMembers = new Set<string>();
    const insertedIds = new Map<string, string[]>();
    const restoredMedia: { id: string; bucketId: string | null; uri: string | null }[] = [];

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await args.onBegin?.(query);
      const live = await liveTables(query, [...wanted.values()]);
      const staged = new Map<string, Staged>();

      // ---- 1. stage ---------------------------------------------------------------------------
      for await (const entry of args.reader.entries()) {
        const m = ENTRY.exec(entry.name);
        const d = m ? wanted.get(m[1]) : undefined;
        if (!d) continue;
        where = { phase: 'stage', model: d.model };
        if (staged.has(d.model)) throw new CheckpointError('RESTORE_FAILED', `The checkpoint holds ${d.model} twice`, { model: d.model });
        const liveCols = live.get(d.model)?.columns ?? [];
        if (!liveCols.length) throw new CheckpointError('RESTORE_FAILED', `Table of ${d.model} no longer exists`, { model: d.model });
        staged.set(d.model, await stageEntry(client, d, entry.body, liveCols));
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
        if (s.dropped.length) warn('COLUMN_DROPPED', `${model}: checkpoint columns the live table no longer has were not restored`, { model, columns: s.dropped });
      }
      for (const d of restorable) {
        if (!staged.has(d.model)) {
          warn('MODEL_NOT_IN_CHECKPOINT', `${d.model} is not in the checkpoint and was left as it is`, { model: d.model });
        }
      }

      const edges = await loadFkEdges(query);
      const order = insertOrder(
        restorable.filter((d) => staged.has(d.model)).map((d) => d.model),
        edges,
      );
      const counts = new Map(order.map((m) => [m, { model: m, inserted: 0, updated: 0, retired: 0 }]));
      const uniqueKeys = await nonPartialUniqueKeys(query, order.map((m) => rawTableName(descriptorFor(m))));

      // ---- 3. plan ----------------------------------------------------------------------------
      for (const model of order) {
        where = { phase: 'plan', model };
        const { d, columns } = staged.get(model)!;
        await client.query(`CREATE TEMP TABLE ${keepTable(d)} ("id" text PRIMARY KEY, "reason" text NOT NULL) ON COMMIT DROP`);
        await client.query(`CREATE TEMP TABLE ${skipTable(d)} ("id" text PRIMARY KEY, "reason" text NOT NULL) ON COMMIT DROP`);
        const keep = (ids: readonly string[], reason: string) => addIds(client, keepTable(d), ids, reason);
        const skip = (ids: readonly string[], reason: string) => addIds(client, skipTable(d), ids, reason);
        const ids = async (sql: string | null) => (sql ? (await query<{ id: string }>(sql, params(sql))).map((r) => r.id) : []);
        const exclusion = async (predicate: string, reason: string) => {
          const affected = await ids(affectedMatchingSql(d, predicate, columns));
          const rows = await query<{ side: string; id: string }>(matchingRowsSql(d, predicate), [tenantId]);
          await keep(rows.filter((r) => r.side === 'live').map((r) => r.id), reason);
          await skip(rows.filter((r) => r.side === 'staged').map((r) => r.id), reason);
          return affected.sort();
        };

        if (d.neverTouch) {
          const affected = await exclusion(d.neverTouch, 'neverTouch');
          if (affected.length) warn('ELEVATED_ROLE_UNTOUCHED', `${model}: assignments of an elevated platform role are never restored`, { model, ids: affected });
        }
        const governedRows = d.platformGoverned?.kind === 'model' ? 'true' : d.platformGoverned?.kind === 'rows' ? d.platformGoverned.where : null;
        if (governedRows && !args.platformAdmin) {
          const affected = await exclusion(governedRows, 'platformGoverned');
          if (affected.length) {
            warn('PLATFORM_GOVERNED_SKIPPED', `${model}: rows only a platform administrator may write were left as they are`, { model, ids: affected });
          }
        }

        const diverged = await ids(divergedSql(d, columns));
        if (diverged.length) {
          await keep(diverged, 'diverged');
          warn('IMMUTABLE_DIVERGED', `${model}: ${diverged.length} row(s) changed after the checkpoint and are immutable now; they were left as they are`, {
            model,
            ids: diverged,
          });
        }

        const crossEdges = edges.filter((e) => {
          const child = CHECKPOINT_REGISTRY.find((x) => x.model === e.child);
          return (
            e.parent === model &&
            e.child !== model &&
            !!child &&
            child.policy !== 'EXCLUDED' &&
            (RESTORABLE_CATEGORIES as readonly string[]).includes(child.category) &&
            !selected.includes(child.category)
          );
        });
        const referenced = await ids(crossCategoryReferencedSql(d, crossEdges));
        if (referenced.length) {
          await keep(referenced, 'crossCategory');
          warn('CROSS_CATEGORY_REFERENCE', `${model}: row(s) still referenced by data of a category this restore does not include were not retired`, {
            model,
            ids: referenced.sort(),
          });
        }

        const frozen = await ids(frozenInsertSql(d));
        if (frozen.length) {
          await skip(frozen, 'frozen');
          warn('IMMUTABLE_DIVERGED', `${model}: ${frozen.length} checkpoint row(s) belong to a record that is immutable now; they were not re-created`, {
            model,
            ids: frozen.sort(),
          });
        }

        if (d.uniqueSlot === 'skip') {
          const claimants = new Set<string>();
          for (const key of uniqueKeys.get(rawTableName(d)) ?? []) {
            if (key.includes('id') || !key.every((c) => columns.includes(c))) continue;
            const rows = await query<{ id: string; holder: string }>(uniqueClaimantsSql(d, key), params(uniqueClaimantsSql(d, key)));
            if (!rows.length) continue;
            await skip(rows.map((r) => r.id), 'uniqueSlot');
            await keep(rows.map((r) => r.holder), 'uniqueSlot');
            rows.forEach((r) => claimants.add(r.id));
          }
          if (claimants.size) {
            warn('UNIQUE_SLOT_HELD', `${model}: checkpoint row(s) need a unique key a live row holds; the live row was kept and the checkpoint row not restored`, {
              model,
              ids: [...claimants].sort(),
            });
          }
        }

        for (const slot of d.slots ?? []) {
          if (!columns.includes(slot.column)) continue;
          const rows = await query<{ id: string; reason: string }>(slotClaimantsSql(d, slot), params(slotClaimantsSql(d, slot)));
          if (!rows.length) continue;
          await skip(rows.map((r) => r.id), 'slotHeld');
          const byDiverged = rows.filter((r) => r.reason === 'diverged').map((r) => r.id);
          const byOther = rows.filter((r) => r.reason !== 'diverged').map((r) => r.id);
          if (byDiverged.length) {
            warn('SLOT_HELD_BY_DIVERGED', `${model}: an immutable row changed after the checkpoint holds the ${slot.column} slot; the checkpoint row was not restored`, {
              model,
              ids: [...new Set(byDiverged)].sort(),
            });
          }
          if (byOther.length) {
            warn('SLOT_HELD_BY_KEPT_ROW', `${model}: a row this restore keeps holds the ${slot.column} slot; the checkpoint row was not restored`, {
              model,
              ids: [...new Set(byOther)].sort(),
            });
          }
        }

        const required = live.get(model)!.required;
        const secretRequired = (d.secretColumns ?? []).filter((c) => required.has(c));
        if (secretRequired.length) {
          const blocked = await ids(insertCandidatesSql(d));
          if (blocked.length) {
            await skip(blocked, 'secret');
            warn('SECRET_REQUIRES_REENTRY', `${model}: row(s) carry a secret that is never restored; re-create them`, { model, ids: blocked.sort(), columns: secretRequired });
          }
        }

        if (d.platformGoverned?.kind === 'columns' && !args.platformAdmin) {
          const cols = d.platformGoverned.columns.filter((c) => columns.includes(c));
          const changed = cols.length ? [...(await ids(differingRowsSql(d, cols))), ...(await ids(insertCandidatesSql(d)))] : [];
          if (changed.length) {
            warn('PLATFORM_GOVERNED_SKIPPED', `${model}: settings only a platform administrator may write were left as they are`, {
              model,
              columns: cols,
              ids: [...new Set(changed)].sort(),
            });
          }
        }
      }

      // ---- 4. retire (children first) -----------------------------------------------------------
      for (const model of [...order].reverse()) {
        where = { phase: 'retire', model };
        const d = descriptorFor(model);
        const cols = live.get(model)!.columns;
        const sql = retireSql(d, { columns: cols, guard: true });
        if (sql) {
          const res = await client.query(sql + returning(model, 'retire'), params(sql));
          counts.get(model)!.retired += res.rowCount ?? 0;
          collect(model, 'retire', res.rows);
        }
        const markers = releaseDeletedMarkersSql(d, { columns: cols, guard: true });
        if (markers) await client.query(markers, params(markers));
        await args.onStep?.({ phase: 'retire', model });
      }

      // ---- 5. update (parents first) ------------------------------------------------------------
      for (const model of order) {
        where = { phase: 'update', model };
        const { d, columns } = staged.get(model)!;
        const exclude = neverWrittenColumns(d, { platformAdmin: args.platformAdmin });
        for (const sql of [updateSql(d, columns, { release: true, guard: true, exclude }), updateSql(d, columns, { guard: true, exclude })]) {
          if (!sql) continue;
          const res = await client.query(sql + returning(model, 'update'), params(sql));
          counts.get(model)!.updated += res.rowCount ?? 0;
          collect(model, 'update', res.rows);
        }
        await args.onStep?.({ phase: 'update', model });
      }

      // ---- 6. insert (parents first) ------------------------------------------------------------
      for (const model of order) {
        where = { phase: 'insert', model };
        const { d, columns } = staged.get(model)!;
        const parents = edges.filter((e) => e.child === model && e.parent !== model && stagedNames.has(e.parent) && e.parentColumn);
        const orphans = orphanInsertsSql(d, parents);
        if (orphans) {
          const orphanIds = (await query<{ id: string }>(orphans, params(orphans))).map((r) => r.id);
          if (orphanIds.length) {
            warn('PARENT_NOT_RESTORED', `${model}: row(s) whose parent record was not restored were not re-created`, { model, ids: orphanIds.sort() });
          }
        }
        const exclude = neverWrittenColumns(d, { platformAdmin: args.platformAdmin });
        const sql = insertSql(d, columns, stagedNames, { guard: true, liveColumns: live.get(model)!.columns, exclude, parents });
        if (sql) {
          const res = await client.query(sql + returning(model, 'insert'), params(sql));
          counts.get(model)!.inserted += res.rowCount ?? 0;
          collect(model, 'insert', res.rows);
        }
        await args.onStep?.({ phase: 'insert', model });
      }

      // ---- warnings about what was written ------------------------------------------------------
      where = { phase: 'report', model: '-' };
      const insertedUsers = insertedIds.get('User') ?? [];
      if (insertedUsers.length) {
        warn('USER_REQUIRES_PASSWORD_RESET', 'Re-created user accounts have no usable password; each must reset it', { userIds: [...insertedUsers].sort() });
      }
      for (const [model, ids] of insertedIds) {
        const d = descriptorFor(model);
        if (d.secretColumns?.length && ids.length) {
          warn('SECRET_REQUIRES_REENTRY', `${model}: re-created row(s) have no secret; enter it again`, { model, ids: [...ids].sort(), columns: d.secretColumns });
        }
      }
      if (restoredMedia.length) {
        const captured = new Set((manifest.media ?? []).map((m) => m.entry));
        const missing = restoredMedia
          .filter((m) => {
            const loc = parseStorageUri(m.uri);
            return !loc || !captured.has(`media/${m.bucketId ?? loc.bucket}/${loc.key}`);
          })
          .map((m) => m.id);
        if (missing.length) {
          warn('MEDIA_NOT_CAPTURED', 'Restored media rows whose bytes are not in the checkpoint', { mediaIds: [...new Set(missing)].sort() });
        }
      }
      if (revivedMembers.size) {
        const deleted = await query<{ id: string }>(`SELECT "id"::text AS id FROM core."User" WHERE "id" = ANY($1) AND "resourceStatus" = 'DELETED'`, [
          [...revivedMembers],
        ]);
        if (deleted.length) {
          warn('USER_DELETED_MEMBERSHIP_RESTORED', 'Memberships were restored for users whose account is deleted; they cannot sign in', {
            userIds: deleted.map((r) => r.id).sort(),
          });
        }
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

      where = { phase: 'commit', model: '-' };
      await args.beforeCommit?.(query);
      await client.query('COMMIT');
      result.counts = order.map((m) => counts.get(m)!);
      result.touchedUserIds = [...touched].sort();
      result.knowledge.reingest = [...reingest].filter((id) => !result.knowledge.retired.includes(id));
      return result;
    } catch (error) {
      // swallow-ok: the original error is what the caller needs; a failed ROLLBACK means the connection is gone (and is released with the error)
      await client.query('ROLLBACK').catch(() => undefined);
      throw toRestoreError(error, where);
    }

    function collect(model: string, phase: ReconcilePhase, rows: Record<string, unknown>[]): void {
      if (MEMBERSHIP_MODELS.has(model)) {
        for (const r of rows) {
          for (const k of ['userId', 'oldUserId']) if (typeof r[k] === 'string') touched.add(r[k] as string);
          if (phase !== 'retire' && typeof r.userId === 'string' && r.resourceStatus !== 'DELETED') revivedMembers.add(r.userId);
        }
        return;
      }
      if (model === 'Media') {
        if (phase !== 'retire') for (const r of rows) restoredMedia.push({ id: String(r.id), bucketId: (r.bucketId as string | null) ?? null, uri: (r.uri as string | null) ?? null });
        return;
      }
      const ids = rows.map((r) => r.id as string);
      if (phase === 'insert' && ids.length) insertedIds.set(model, [...(insertedIds.get(model) ?? []), ...ids]);
      if (model === 'Consultation' && phase === 'retire') result.retiredConsultationIds.push(...ids);
      if (model === 'ServiceAccount' && phase === 'retire') result.retiredServiceAccountIds.push(...ids);
      if (model === 'KnowledgeDocument') {
        if (phase === 'retire') result.knowledge.retired.push(...ids);
        else ids.forEach((id) => reingest.add(id));
      }
    }
  }
}

/** RETURNING clause for the models whose affected rows feed post-commit work or a warning. */
function returning(model: string, phase: ReconcilePhase): string {
  const p = phase === 'insert' ? '' : 'l.';
  if (MEMBERSHIP_MODELS.has(model)) {
    if (phase === 'update') return ` RETURNING old."userId" AS "oldUserId", new."userId" AS "userId", new."resourceStatus" AS "resourceStatus"`;
    return phase === 'insert' ? ` RETURNING "userId", "resourceStatus"` : ` RETURNING l."userId"`;
  }
  if (model === 'Media') return phase === 'retire' ? '' : ` RETURNING ${p}"id", ${p}"bucketId", ${p}"uri"`;
  if (ID_MODELS.has(model) || (phase === 'insert' && descriptorFor(model).secretColumns?.length)) return ` RETURNING ${p}"id"`;
  return '';
}

async function addIds(client: PoolClient, table: string, ids: readonly string[], reason: string): Promise<void> {
  if (!ids.length) return;
  await client.query(`INSERT INTO ${table} ("id", "reason") SELECT unnest($1::text[]), $2 ON CONFLICT ("id") DO NOTHING`, [[...new Set(ids)], reason]);
}

async function liveTables(query: SqlQuery, descriptors: readonly CheckpointModelDescriptor[]): Promise<Map<string, LiveTable>> {
  const byTable = new Map(descriptors.map((d) => [rawTableName(d), d.model]));
  const rows = await query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'core' AND table_name = ANY($1) AND is_generated <> 'ALWAYS'
      ORDER BY table_name, ordinal_position`,
    [[...byTable.keys()]],
  );
  const out = new Map<string, LiveTable>(descriptors.map((d) => [d.model, { columns: [], required: new Set<string>() }]));
  for (const r of rows) {
    const t = out.get(byTable.get(r.table_name)!)!;
    t.columns.push(r.column_name);
    if (r.is_nullable === 'NO' && r.column_default === null) t.required.add(r.column_name);
  }
  return out;
}

/** Non-partial, non-expression unique keys (primary keys excluded) of the given core tables. */
async function nonPartialUniqueKeys(query: SqlQuery, tables: readonly string[]): Promise<Map<string, string[][]>> {
  const rows = await query<{ table: string; cols: string[] }>(
    `SELECT t.relname AS "table", array_agg(a.attname::text ORDER BY k.ord) AS cols
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'core' AND ix.indisunique AND NOT ix.indisprimary AND ix.indpred IS NULL AND ix.indexprs IS NULL
        AND t.relname = ANY($1)
      GROUP BY ix.indexrelid, t.relname`,
    [[...tables]],
  );
  const out = new Map<string, string[][]>();
  for (const r of rows) out.set(r.table, [...(out.get(r.table) ?? []), r.cols]);
  return out;
}

async function stageEntry(client: PoolClient, d: CheckpointModelDescriptor, body: NodeJS.ReadableStream, liveCols: readonly string[]): Promise<Staged> {
  const stg = stagingTable(d);
  const live = new Set(liveCols);
  await client.query(`CREATE TEMP TABLE ${stg} (LIKE ${tableName(d)} INCLUDING DEFAULTS) ON COMMIT DROP`);
  // Redacted / secret columns arrive NULL (or are never written): staging must accept that.
  const loose = [...new Set([...(d.redactColumns ?? []), ...(d.secretColumns ?? [])])].filter((c) => live.has(c));
  if (loose.length) await client.query(`ALTER TABLE ${stg} ${loose.map((c) => `ALTER COLUMN ${q(c)} DROP NOT NULL`).join(', ')}`);
  const filter = new CsvColumnFilter((c) => live.has(c));
  const feeding = pipeline(body, createGunzip(), filter);
  // swallow-ok: the same rejection is awaited below through Promise.all
  feeding.catch(() => undefined);
  const columns = await Promise.race([filter.kept, feeding.then(() => filter.kept)]);
  if (!columns.includes('id')) throw new CheckpointError('RESTORE_FAILED', `${d.model}: the checkpoint table has no id column`, { model: d.model });
  const copy = client.query(copyFrom(`COPY ${stg} (${columns.map(q).join(', ')}) FROM STDIN (FORMAT csv, HEADER true)`));
  await Promise.all([feeding, pipeline(filter, copy)]);
  await client.query(`ANALYZE ${stg}`);
  const dropped = filter.columns().filter((c) => !live.has(c));
  return { d, columns, dropped, rows: filter.rows };
}

/** Postgres refused to serialise this transaction against a concurrent writer. */
const SERIALIZATION_CODES = new Set(['40001', '40P01']);

function toRestoreError(error: unknown, where: { phase: string; model: string }): CheckpointError {
  if (error instanceof CheckpointError) return error;
  const pg = error as { code?: string; constraint?: string };
  if (pg?.code && SERIALIZATION_CODES.has(pg.code)) {
    return new CheckpointError('RESTORE_FAILED', 'concurrent write — retry', { model: where.model, phase: where.phase, code: pg.code });
  }
  if (pg?.code === '23505') {
    return new CheckpointError(
      'RESTORE_FAILED',
      `Restoring ${where.model} would violate unique constraint ${pg.constraint ?? '(unknown)'}: a live row created after the checkpoint holds the same key`,
      { model: where.model, phase: where.phase, constraint: pg.constraint ?? null, code: pg.code },
    );
  }
  // Never the driver's message verbatim: a detail line may quote row values.
  const what = pg?.code ? `database error ${pg.code}${pg.constraint ? ` on ${pg.constraint}` : ''}` : ((error as Error)?.message ?? String(error));
  return new CheckpointError('RESTORE_FAILED', `Restore failed in the ${where.phase} phase of ${where.model}: ${what}`, {
    model: where.model,
    phase: where.phase,
    ...(pg?.code ? { code: pg.code } : {}),
  });
}

