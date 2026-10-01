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
export function retireSql(d: CheckpointModelDescriptor, ctx: { columns: readonly string[] }): string | null {
  if (d.policy !== 'RECONCILE' && d.policy !== 'RETIRE_ONLY') return null;
  const table = tableName(d);
  const absent = `NOT EXISTS (SELECT 1 FROM ${stagingTable(d)} s WHERE s."id" = l."id")`;
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
 * Overwrite live rows that are also in the checkpoint and differ from it (RECONCILE only; run
 * parents first). Rows equal to the checkpoint are not touched and keep their `_version`.
 *
 * `opts.release` restricts the statement to rows that GIVE UP a partial-unique slot (going
 * inactive or deleted). Running that pass first lets one restore swap which row holds a slot
 * without tripping the unique index mid-statement; the main pass then skips those rows because
 * they already equal the checkpoint.
 */
export function updateSql(d: CheckpointModelDescriptor, columns: readonly string[], opts: { release?: boolean } = {}): string | null {
  if (d.policy !== 'RECONCILE') return null;
  if (isWholeRowFrozen(d) && d.immutableWhen === 'true') return null;
  const cols = restorableColumns(d, columns);
  if (!cols.length) return null;

  let release = '';
  if (opts.release) {
    const r: string[] = [];
    if (columns.includes('isActive')) r.push(`(l."isActive" AND NOT s."isActive")`);
    if (columns.includes('resourceStatus')) r.push(`(l."resourceStatus" <> 'DELETED' AND s."resourceStatus" = 'DELETED')`);
    if (!r.length) return null;
    release = ` AND (${r.join(' OR ')})`;
  }

  let guard = '';
  if (isWholeRowFrozen(d)) guard = ` AND NOT (${d.immutableWhen})`;
  else if (d.immutableWhen && d.immutableColumns?.length) {
    const imm = d.immutableColumns.filter((c) => cols.includes(c));
    if (imm.length) guard = ` AND NOT ((${d.immutableWhen}) AND (${distinct(imm)}))`;
  }

  const set = [...cols.map((c) => `${q(c)} = s.${q(c)}`), ...stamps(columns)];
  return (
    `UPDATE ${tableName(d)} l SET ${set.join(', ')} FROM ${stagingTable(d)} s ` +
    `WHERE s."id" = l."id" AND ${scopePredicate(d, 'l')}${guard}${release} AND (${distinct(cols)})`
  );
}

/**
 * Insert checkpoint rows missing live (RECONCILE and INSERT_ONLY; run parents first). The staged
 * row's tenant scope is re-asserted in the statement itself (`staged` = the staged models).
 */
export function insertSql(d: CheckpointModelDescriptor, columns: readonly string[], staged: ReadonlySet<string> = new Set([d.model])): string | null {
  if (d.policy !== 'RECONCILE' && d.policy !== 'INSERT_ONLY') return null;
  if (!columns.includes('id')) throw new Error(`checkpoint restore: ${d.model} staging has no id column`);
  const list = columns.map(q).join(', ');
  const select = columns.map((c) => `s.${q(c)}`).join(', ');
  const table = tableName(d);
  return (
    `INSERT INTO ${table} (${list}) SELECT ${select} FROM ${stagingTable(d)} s ` +
    `WHERE ${stagingScopePredicate(d, 's', staged)} AND NOT EXISTS (SELECT 1 FROM ${table} l WHERE l."id" = s."id")`
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
