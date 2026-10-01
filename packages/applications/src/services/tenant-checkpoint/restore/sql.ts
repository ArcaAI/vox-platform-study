/**
 * Reconcile SQL — pure builders, one statement per (model, phase). Every statement carries the
 * descriptor's tenant scope with `$1` = the tenant id; `$2`, when present, is the restore actor.
 *
 * The live table is aliased `l`, the staging table (the checkpoint's rows) `s`. Column lists are
 * the intersection of the checkpoint's columns and the live table's, so a column dropped since the
 * checkpoint is never written and a column added since keeps its live value (update) or its
 * default (insert).
 *
 * Immutability: a descriptor with `immutableColumns` + `immutableWhen` mirrors a trigger that
 * refuses changes to those columns while `immutableWhen` holds on the LIVE row. Such a row whose
 * immutable content differs from the checkpoint is left untouched as a whole — status included,
 * so a published row can never be flipped back to an editable draft — and reported as diverged.
 * `immutableColumns: ['*']` freezes the whole row: it is neither updated nor retired.
 */
import type { CheckpointModelDescriptor } from '../contracts';
import { aliased, occupies, sameSlot, type CheckpointSlot } from '../registry/descriptor-ext';
import type { FkEdge } from '../registry/order';
import { descriptorFor, tableName } from '../registry/registry';
import { scopePredicate } from '../registry/scope';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Columns never copied from staging by an UPDATE: identity, OCC counter, and the write stamps. */
const NOT_RESTORED_ON_UPDATE = new Set(['id', 'tenantId', '_version', 'updatedAt', 'updatedBy']);

export function q(column: string): string {
  if (!IDENT.test(column)) throw new Error(`checkpoint restore: unsafe column name "${column}"`);
  return `"${column}"`;
}

/** `pg_temp."stg_<Model>"` — dropped at commit or rollback. */
export function stagingTable(d: CheckpointModelDescriptor): string {
  if (!IDENT.test(d.model)) throw new Error(`checkpoint restore: unsafe model name "${d.model}"`);
  return `pg_temp."stg_${d.model}"`;
}

function scopeColumn(d: CheckpointModelDescriptor): string | null {
  return d.scope.kind === 'tenantColumn' ? (d.scope.column ?? 'tenantId') : null;
}

/** Columns an UPDATE copies from staging. */
export function restorableColumns(d: CheckpointModelDescriptor, columns: readonly string[]): string[] {
  const scope = scopeColumn(d);
  return columns.filter((c) => !NOT_RESTORED_ON_UPDATE.has(c) && c !== scope);
}

/**
 * Columns a restore never writes from a checkpoint value: redacted credentials, secrets (never
 * rewound), and — unless a platform admin requested the restore — platform-governed columns.
 */
export function neverWrittenColumns(d: CheckpointModelDescriptor, opts: { platformAdmin?: boolean } = {}): Set<string> {
  const out = new Set<string>([...(d.redactColumns ?? []), ...(d.secretColumns ?? [])]);
  if (d.platformGoverned?.kind === 'columns' && !opts.platformAdmin) for (const c of d.platformGoverned.columns) out.add(c);
  return out;
}

/** `pg_temp."keep_<Model>"` — LIVE ids the restore must leave untouched (never retired, never updated). */
export function keepTable(d: CheckpointModelDescriptor): string {
  return `pg_temp."keep_${stagingTable(d).slice('pg_temp."stg_'.length, -1)}"`;
}

/** `pg_temp."skip_<Model>"` — STAGED ids the restore must not write (never updated from, never inserted). */
export function skipTable(d: CheckpointModelDescriptor): string {
  return `pg_temp."skip_${stagingTable(d).slice('pg_temp."stg_'.length, -1)}"`;
}

const notKept = (d: CheckpointModelDescriptor, alias: string) => `NOT EXISTS (SELECT 1 FROM ${keepTable(d)} k WHERE k."id" = ${alias}."id"::text)`;
const notSkipped = (d: CheckpointModelDescriptor, alias: string) => `NOT EXISTS (SELECT 1 FROM ${skipTable(d)} k WHERE k."id" = ${alias}."id"::text)`;

/** Clears of a soft retire beyond resourceStatus: every slot the row holds, then `retireSet`. */
function retireClears(d: CheckpointModelDescriptor, cols: readonly string[], already: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const slot of d.slots ?? []) {
    if (already.has(slot.column) || !cols.includes(slot.column)) continue;
    out.push(slot.kind === 'flag' ? `${q(slot.column)} = false` : `${q(slot.column)} = NULL`);
  }
  return [...out, ...(d.retireSet ?? [])];
}

function isWholeRowFrozen(d: CheckpointModelDescriptor): boolean {
  return !!d.immutableWhen && (d.immutableColumns ?? []).includes('*');
}

function distinct(columns: readonly string[]): string {
  return columns.map((c) => `l.${q(c)} IS DISTINCT FROM s.${q(c)}`).join(' OR ');
}

function stamps(columns: readonly string[], present: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  if (columns.includes('updatedAt') && !present.has('updatedAt')) out.push(`"updatedAt" = now()`);
  if (columns.includes('updatedBy') && !present.has('updatedBy')) out.push(`"updatedBy" = $2`);
  if (columns.includes('_version') && !present.has('_version')) out.push(`"_version" = l."_version" + 1`);
  return out;
}

/** Splits `"a" = x, "b" = f(y, z)` at top-level commas into column/expression pairs. */
function parseSetSql(setSql: string): { column: string; expr: string }[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < setSql.length; i++) {
    const ch = setSql[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(setSql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(setSql.slice(start));
  return parts.map((p) => {
    const m = /^\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*=\s*(.+?)\s*$/s.exec(p);
    if (!m) throw new Error(`checkpoint restore: unparseable revoke SET clause "${p.trim()}"`);
    return { column: m[1], expr: m[2] };
  });
}

/**
 * Retire live in-scope rows absent from the checkpoint (run children first).
 * `ctx.columns` are the LIVE table's columns. Null when the descriptor never retires.
 */
export function retireSql(d: CheckpointModelDescriptor, ctx: { columns: readonly string[]; guard?: boolean }): string | null {
  if (d.policy !== 'RECONCILE' && d.policy !== 'RETIRE_ONLY') return null;
  const table = tableName(d);
  const absent = `NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s WHERE s."id" = l."id")${ctx.guard ? ` AND ${notKept(d, 'l')}` : ''}`;
  const frozen = isWholeRowFrozen(d) ? ` AND NOT (${d.immutableWhen})` : '';
  const scope = scopePredicate(d, 'l');
  const cols = ctx.columns;

  switch (d.retire.kind) {
    case 'never':
      return null;
    case 'hardDelete':
      return `DELETE FROM ${table} l WHERE ${scope}${frozen} AND ${absent}`;
    case 'softDelete': {
      const set = [`"resourceStatus" = 'DELETED'`];
      if (cols.includes('resourceStatusUpdatedAt')) set.push(`"resourceStatusUpdatedAt" = now()`);
      if (cols.includes('resourceStatusUpdatedBy')) set.push(`"resourceStatusUpdatedBy" = $2`);
      if (cols.includes('isActive')) set.push(`"isActive" = false`);
      set.push(...retireClears(d, cols, new Set(['isActive'])));
      set.push(...stamps(cols));
      return `UPDATE ${table} l SET ${set.join(', ')} WHERE ${scope} AND l."resourceStatus" <> 'DELETED'${frozen} AND ${absent}`;
    }
    case 'revoke': {
      const parsed = parseSetSql(d.retire.setSql);
      const present = new Set(parsed.map((p) => p.column));
      const guard = parsed
        .filter((p) => !/^now\(\)$/i.test(p.expr))
        .map((p) => `l.${q(p.column)} IS DISTINCT FROM ${p.expr}`)
        .join(' OR ');
      const set = [d.retire.setSql.trim(), ...stamps(cols, present)];
      return `UPDATE ${table} l SET ${set.join(', ')} WHERE ${scope}${guard ? ` AND (${guard})` : ''}${frozen} AND ${absent}`;
    }
  }
}

/**
 * A marker slot (plain unique, NOT partial) is still held by a row soft-deleted before the restore;
 * the retire statement never touches DELETED rows, so release those markers separately (the same
 * cleanup as the TASK-958 tombstone migration). Null when the model has no marker slot.
 */
export function releaseDeletedMarkersSql(d: CheckpointModelDescriptor, ctx: { columns: readonly string[]; guard?: boolean }): string | null {
  if (d.policy !== 'RECONCILE' || d.retire.kind !== 'softDelete') return null;
  const markers = (d.slots ?? []).filter((x) => x.kind === 'marker' && ctx.columns.includes(x.column));
  if (!markers.length) return null;
  const set = [...markers.map((x) => `${q(x.column)} = NULL`), ...stamps(ctx.columns)];
  const held = markers.map((x) => `l.${q(x.column)} IS NOT NULL`).join(' OR ');
  return (
    `UPDATE ${tableName(d)} l SET ${set.join(', ')} WHERE ${scopePredicate(d, 'l')} AND l."resourceStatus" = 'DELETED' AND (${held}) ` +
    `AND NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s WHERE s."id" = l."id")${ctx.guard ? ` AND ${notKept(d, 'l')}` : ''}`
  );
}

/**
 * Overwrite live rows that are also in the checkpoint and differ from it (RECONCILE only; run
 * parents first). Rows equal to the checkpoint are not touched and keep their `_version`.
 *
 * `opts.release` restricts the statement to rows that GIVE UP a partial-unique slot (going
 * inactive or deleted). Running that pass first lets one restore swap which row holds a slot
 * without tripping the unique index mid-statement; the main pass then skips those rows because
 * they already equal the checkpoint.
 */
export function updateSql(
  d: CheckpointModelDescriptor,
  columns: readonly string[],
  opts: { release?: boolean; guard?: boolean; exclude?: ReadonlySet<string> } = {},
): string | null {
  if (d.policy !== 'RECONCILE') return null;
  if (isWholeRowFrozen(d) && d.immutableWhen === 'true') return null;
  const cols = restorableColumns(d, columns).filter((c) => !opts.exclude?.has(c));
  if (!cols.length) return null;

  let release = '';
  if (opts.release) {
    const r: string[] = [];
    if (columns.includes('isActive')) r.push(`(l."isActive" AND NOT s."isActive")`);
    for (const slot of d.slots ?? []) {
      if (slot.column === 'isActive' || !columns.includes(slot.column)) continue;
      r.push(
        slot.kind === 'flag'
          ? `(l.${q(slot.column)} AND NOT s.${q(slot.column)})`
          : `(l.${q(slot.column)} IS NOT NULL AND s.${q(slot.column)} IS DISTINCT FROM l.${q(slot.column)})`,
      );
    }
    if (columns.includes('resourceStatus')) r.push(`(l."resourceStatus" <> 'DELETED' AND s."resourceStatus" = 'DELETED')`);
    if (!r.length) return null;
    release = ` AND (${r.join(' OR ')})`;
  }
  const guards = opts.guard ? ` AND ${notKept(d, 'l')} AND ${notSkipped(d, 's')}` : '';

  let guard = '';
  if (isWholeRowFrozen(d)) guard = ` AND NOT (${d.immutableWhen})`;
  else if (d.immutableWhen && d.immutableColumns?.length) {
    const imm = d.immutableColumns.filter((c) => cols.includes(c));
    if (imm.length) guard = ` AND NOT ((${d.immutableWhen}) AND (${distinct(imm)}))`;
  }

  const set = [...cols.map((c) => `${q(c)} = s.${q(c)}`), ...stamps(columns)];
  return (
    `UPDATE ${tableName(d)} l SET ${set.join(', ')} FROM ${stagingTable(d)} s ` +
    `WHERE s."id" = l."id" AND ${scopePredicate(d, 'l')}${guard}${guards}${release} AND (${distinct(cols)})`
  );
}

/**
 * Insert checkpoint rows missing live (RECONCILE and INSERT_ONLY; run parents first). The staged
 * row's tenant scope is re-asserted in the statement itself (`staged` = the staged models).
 */
export interface InsertOptions {
  /** Add the keep/skip guard and the parent-exists guards (the reconciler always does). */
  guard?: boolean;
  /** Live columns of the table: a redacted NOT NULL column absent from the checkpoint still gets its insert value. */
  liveColumns?: readonly string[];
  /** Columns never written from the checkpoint (`neverWrittenColumns`). */
  exclude?: ReadonlySet<string>;
  /** Foreign keys of this model to a staged parent: a row whose parent is not live is not inserted. */
  parents?: readonly FkEdge[];
}

/** Values of the insert: checkpoint column, or the redaction value, or nothing (live default). */
function insertColumns(d: CheckpointModelDescriptor, columns: readonly string[], opts: InsertOptions): { column: string; expr: string }[] {
  const redacted = new Set(d.redactColumns ?? []);
  const out: { column: string; expr: string }[] = [];
  for (const c of columns) {
    if (redacted.has(c)) {
      out.push({ column: c, expr: d.redactInsert?.[c] ?? 'NULL' });
      continue;
    }
    if (opts.exclude?.has(c)) continue;
    out.push({ column: c, expr: `s.${q(c)}` });
  }
  for (const [c, expr] of Object.entries(d.redactInsert ?? {})) {
    if (!columns.includes(c) && opts.liveColumns?.includes(c)) out.push({ column: c, expr });
  }
  return out;
}

/** `s.fk IS NULL OR the parent row exists live` for every FK of `d` to a staged parent model. */
export function parentGuards(d: CheckpointModelDescriptor, parents: readonly FkEdge[]): string[] {
  return parents
    .filter((e) => e.child === d.model && e.parentColumn)
    .map((e) => {
      const p = descriptorFor(e.parent);
      return `(s.${q(e.column)} IS NULL OR EXISTS (SELECT 1 FROM ${tableName(p)} lp WHERE lp.${q(e.parentColumn!)} = s.${q(e.column)}))`;
    });
}

export function insertSql(
  d: CheckpointModelDescriptor,
  columns: readonly string[],
  staged: ReadonlySet<string> = new Set([d.model]),
  opts: InsertOptions = {},
): string | null {
  if (d.policy !== 'RECONCILE' && d.policy !== 'INSERT_ONLY') return null;
  if (!columns.includes('id')) throw new Error(`checkpoint restore: ${d.model} staging has no id column`);
  const values = insertColumns(d, columns, opts);
  const list = values.map((v) => q(v.column)).join(', ');
  const select = values.map((v) => v.expr).join(', ');
  const table = tableName(d);
  const guards = opts.guard ? [notSkipped(d, 's'), ...parentGuards(d, opts.parents ?? [])].map((g) => ` AND ${g}`).join('') : '';
  return (
    `INSERT INTO ${table} (${list}) SELECT ${select} FROM ${stagingTable(d)} s ` +
    `WHERE ${stagingScopePredicate(d, 's', staged)} AND NOT EXISTS (SELECT 1 FROM ${table} l WHERE l."id" = s."id")${guards}`
  );
}

// ---- planning: which live rows to keep and which staged rows to skip ------------------------

/** Staged rows whose id is not live — the insert candidates (not yet filtered by the skip table). */
function toInsert(d: CheckpointModelDescriptor): string {
  return `NOT EXISTS (SELECT 1 FROM ${tableName(d)} x WHERE x."id" = s."id")`;
}

/** Live in-scope rows a retire would act on (absent from the checkpoint, not frozen, not kept). */
function retireCandidates(d: CheckpointModelDescriptor): string {
  const parts = [scopePredicate(d, 'l'), `NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s WHERE s."id" = l."id")`, notKept(d, 'l')];
  if (d.retire.kind === 'softDelete') parts.push(`l."resourceStatus" <> 'DELETED'`);
  if (isWholeRowFrozen(d)) parts.push(`NOT (${d.immutableWhen})`);
  return parts.join(' AND ');
}

/** Rows matching an `{a}` predicate: live in-scope ids and staged ids, in one result (`side`). */
export function matchingRowsSql(d: CheckpointModelDescriptor, where: string): string {
  return (
    `SELECT 'live' AS side, l."id"::text AS id FROM ${tableName(d)} l WHERE ${scopePredicate(d, 'l')} AND (${aliased(where, 'l')}) ` +
    `UNION ALL SELECT 'staged' AS side, s."id"::text AS id FROM ${stagingTable(d)} s WHERE (${aliased(where, 's')})`
  );
}

/**
 * Live rows a retire would remove although a live row of an UNSELECTED restorable category still
 * references them through a foreign key (`edges` = those referencing edges).
 */
export function crossCategoryReferencedSql(d: CheckpointModelDescriptor, edges: readonly FkEdge[]): string | null {
  if (d.retire.kind === 'never' || !edges.length) return null;
  const refs = edges.map((e) => {
    const c = descriptorFor(e.child);
    const live = c.softDelete ? ` AND c."resourceStatus" <> 'DELETED'` : '';
    return `EXISTS (SELECT 1 FROM ${tableName(c)} c WHERE c.${q(e.column)} = l.${q(e.parentColumn ?? 'id')}${live})`;
  });
  return `SELECT l."id"::text AS id FROM ${tableName(d)} l WHERE ${retireCandidates(d)} AND (${refs.join(' OR ')})`;
}

/** Insert candidates frozen by `insertFrozenWhen` (e.g. a fallback under a live published agent). */
export function frozenInsertSql(d: CheckpointModelDescriptor): string | null {
  if (!d.insertFrozenWhen || (d.policy !== 'RECONCILE' && d.policy !== 'INSERT_ONLY')) return null;
  return `SELECT s."id"::text AS id FROM ${stagingTable(d)} s WHERE ${toInsert(d)} AND ${notSkipped(d, 's')} AND (${aliased(d.insertFrozenWhen, 's')})`;
}

/**
 * Claimants of a non-partial unique `key` held by a live row the restore will not remove:
 * a staged row (to insert, or to update onto a key it does not own yet) and the holder.
 * A holder is removed only when this model is hard-deleted on retire and the holder is a retire
 * candidate; a soft-deleted row keeps its slot.
 */
export function uniqueClaimantsSql(d: CheckpointModelDescriptor, key: readonly string[]): string {
  // The holder is aliased `l` so `retireCandidates` (and an `immutableWhen` over `l`) apply to it.
  const eq = key.map((c) => `l.${q(c)} = s.${q(c)}`).join(' AND ');
  const owns = key.map((c) => `x.${q(c)} = s.${q(c)}`).join(' AND ');
  const removed = d.retire.kind === 'hardDelete' ? ` AND NOT (${retireCandidates(d)})` : '';
  const holderStays = `(NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s2 WHERE s2."id" = l."id") OR EXISTS (SELECT 1 FROM ${keepTable(d)} k WHERE k."id" = l."id"::text))`;
  return (
    `SELECT s."id"::text AS id, l."id"::text AS holder FROM ${stagingTable(d)} s JOIN ${tableName(d)} l ON ${eq} AND l."id" <> s."id" ` +
    `WHERE ${notSkipped(d, 's')} AND NOT EXISTS (SELECT 1 FROM ${tableName(d)} x WHERE x."id" = s."id" AND ${owns}) ` +
    `AND ${holderStays}${removed}`
  );
}

/** Staged rows claiming `slot` while a row the restore keeps (holder in the keep table) occupies it. */
export function slotClaimantsSql(d: CheckpointModelDescriptor, slot: CheckpointSlot): string {
  return (
    `SELECT s."id"::text AS id, k."reason" AS reason FROM ${stagingTable(d)} s ` +
    `JOIN ${tableName(d)} h ON ${sameSlot(slot, 'h', 's')} AND h."id" <> s."id" AND ${occupies(slot, 'h')} ` +
    `JOIN ${keepTable(d)} k ON k."id" = h."id"::text ` +
    `WHERE ${occupies(slot, 's')} AND ${notSkipped(d, 's')}`
  );
}

/** Insert candidates (not skipped) failing a parent-exists guard. */
export function orphanInsertsSql(d: CheckpointModelDescriptor, parents: readonly FkEdge[]): string | null {
  const guards = parentGuards(d, parents);
  if (!guards.length || (d.policy !== 'RECONCILE' && d.policy !== 'INSERT_ONLY')) return null;
  return `SELECT s."id"::text AS id FROM ${stagingTable(d)} s WHERE ${toInsert(d)} AND ${notSkipped(d, 's')} AND NOT (${guards.join(' AND ')})`;
}

/** Insert candidates (not skipped) — for warnings that name rows an insert would create. */
export function insertCandidatesSql(d: CheckpointModelDescriptor): string {
  return `SELECT s."id"::text AS id FROM ${stagingTable(d)} s WHERE ${toInsert(d)} AND ${notSkipped(d, 's')}`;
}

/** Joined rows whose `columns` differ between live and checkpoint (not kept / skipped). */
export function differingRowsSql(d: CheckpointModelDescriptor, columns: readonly string[]): string {
  return (
    `SELECT l."id"::text AS id FROM ${tableName(d)} l JOIN ${stagingTable(d)} s ON s."id" = l."id" ` +
    `WHERE ${scopePredicate(d, 'l')} AND ${notKept(d, 'l')} AND ${notSkipped(d, 's')} AND (${distinct(columns)})`
  );
}

/**
 * Ids of live in-scope rows the update must skip because their immutable content differs from
 * the checkpoint (reported as IMMUTABLE_DIVERGED). Null for descriptors without immutability.
 */
export function divergedSql(d: CheckpointModelDescriptor, columns: readonly string[]): string | null {
  if (d.policy !== 'RECONCILE' || !d.immutableWhen || !d.immutableColumns?.length) return null;
  const cols = restorableColumns(d, columns);
  const compared = isWholeRowFrozen(d) ? cols : d.immutableColumns.filter((c) => cols.includes(c));
  if (!compared.length) return null;
  return (
    `SELECT l."id" FROM ${tableName(d)} l JOIN ${stagingTable(d)} s ON s."id" = l."id" ` +
    `WHERE ${scopePredicate(d, 'l')} AND (${d.immutableWhen}) AND (${distinct(compared)})`
  );
}

const STAGED_MEMBER_TABLES = ['UserRoleAssignment', 'UserDepartment'] as const;

/**
 * Scope predicate over a STAGING row `alias`: the row must belong to the tenant either through
 * the live database or through other staged (and themselves scope-checked) rows — a child whose
 * parent is being re-inserted has no live parent yet.
 */
export function stagingScopePredicate(d: CheckpointModelDescriptor, alias: string, staged: ReadonlySet<string>): string {
  const scope = d.scope;
  switch (scope.kind) {
    case 'tenantColumn':
      return `${alias}.${q(scope.column ?? 'tenantId')} = $1`;
    case 'parent': {
      const parent = descriptorFor(scope.parent);
      const live = `SELECT lp."id" FROM ${tableName(parent)} lp WHERE ${scopePredicate(parent, 'lp')}`;
      const fromStaging = staged.has(parent.model) ? `SELECT sp."id" FROM ${stagingTable(parent)} sp UNION ` : '';
      return `${alias}.${q(scope.fk)} IN (${fromStaging}${live})`;
    }
    case 'tenantMembers': {
      const members = [
        `SELECT "userId" FROM core."UserRoleAssignment" WHERE "tenantId" = $1`,
        `SELECT "userId" FROM core."UserDepartment" WHERE "tenantId" = $1`,
        ...STAGED_MEMBER_TABLES.filter((m) => staged.has(m)).map((m) => `SELECT "userId" FROM ${stagingTable(descriptorFor(m))}`),
      ];
      return `${alias}."id" IN (${members.join(' UNION ')})`;
    }
    case 'none':
      throw new Error(`checkpoint restore: ${d.model} is EXCLUDED and cannot be staged`);
  }
}

/** Count of staged rows outside the tenant — must be 0 before anything is written. */
export function scopeViolationsSql(d: CheckpointModelDescriptor, staged: ReadonlySet<string>): string {
  return `SELECT count(*)::int AS n FROM ${stagingTable(d)} s WHERE NOT COALESCE(${stagingScopePredicate(d, 's', staged)}, false)`;
}

/**
 * Ids the restore WOULD change among rows matching an `{a}` predicate: live matches it would retire,
 * staged matches it would insert, and joined rows (matching on either side) whose `columns` differ.
 */
export function affectedMatchingSql(d: CheckpointModelDescriptor, where: string, columns: readonly string[]): string {
  const cols = restorableColumns(d, columns);
  const live = d.retire.kind === 'softDelete' ? ` AND l."resourceStatus" <> 'DELETED'` : '';
  const parts = [
    `SELECT l."id"::text AS id FROM ${tableName(d)} l WHERE ${scopePredicate(d, 'l')} AND (${aliased(where, 'l')})${live} ` +
      `AND NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s WHERE s."id" = l."id")`,
    `SELECT s."id"::text AS id FROM ${stagingTable(d)} s WHERE (${aliased(where, 's')}) AND ${toInsert(d)}`,
  ];
  if (cols.length) {
    parts.push(
      `SELECT l."id"::text AS id FROM ${tableName(d)} l JOIN ${stagingTable(d)} s ON s."id" = l."id" ` +
        `WHERE ${scopePredicate(d, 'l')} AND ((${aliased(where, 'l')}) OR (${aliased(where, 's')})) AND (${distinct(cols)})`,
    );
  }
  return parts.join(' UNION ');
}

