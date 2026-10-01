import { createHash } from 'node:crypto';
import type { ManifestSummary, SqlQuery } from '../contracts';
import { CHECKPOINT_REGISTRY, rawTableName } from './registry';

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
  is_generated?: 'ALWAYS' | 'NEVER' | null;
}

const COLUMNS_SQL = `SELECT table_name, column_name, is_nullable, column_default, is_identity, is_generated
FROM information_schema.columns
WHERE table_schema = 'core'`;

function physicalTable(model: string): string {
  const d = CHECKPOINT_REGISTRY.find((x) => x.model === model);
  return d ? rawTableName(d) : model;
}

async function columnsOf(query: SqlQuery, tables?: readonly string[]): Promise<ColumnRow[]> {
  return tables
    ? query<ColumnRow>(`${COLUMNS_SQL} AND table_name = ANY($1) ORDER BY table_name, ordinal_position`, [tables])
    : query<ColumnRow>(`${COLUMNS_SQL} ORDER BY table_name, ordinal_position`);
}

/** Live columns (ordinal order) for each given model, keyed by model name; `[]` when the table is absent. */
export async function currentColumns(query: SqlQuery, tables: readonly string[]): Promise<Record<string, string[]>> {
  const physical = new Map(tables.map((m) => [physicalTable(m), m]));
  const out: Record<string, string[]> = Object.fromEntries(tables.map((m) => [m, [] as string[]]));
  for (const row of await columnsOf(query, [...physical.keys()])) {
    const model = physical.get(row.table_name);
    if (model) out[model].push(row.column_name);
  }
  return out;
}

/**
 * sha256 (hex) over the applied migration names and every core table's sorted column list.
 * A `db push`-managed database has no `_prisma_migrations` ledger; its migration list is empty.
 */
export async function schemaFingerprint(query: SqlQuery): Promise<string> {
  const [{ ledger } = { ledger: null }] = await query<{ ledger: string | null }>(
    `SELECT COALESCE(to_regclass('_prisma_migrations'), to_regclass('public._prisma_migrations'), to_regclass('core._prisma_migrations'))::text AS ledger`,
  );
  const migrations = ledger
    ? (
        await query<{ migration_name: string }>(
          `SELECT migration_name FROM ${ledger} WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
        )
      ).map((r) => r.migration_name)
    : [];
  const tables: Record<string, string[]> = {};
  for (const row of await columnsOf(query)) (tables[row.table_name] ??= []).push(row.column_name);
  const sorted = Object.fromEntries(
    Object.keys(tables)
      .sort()
      .map((t) => [t, [...tables[t]].sort()]),
  );
  return createHash('sha256').update(JSON.stringify({ migrations, tables: sorted })).digest('hex');
}

export interface CompatibilityProblem {
  model: string;
  column: string;
  problem: 'NOT_NULL_WITHOUT_DEFAULT' | 'TABLE_MISSING';
}

/**
 * Can the checkpoint's tables be staged into the live schema? A column the checkpoint has but the
 * table dropped is fine (it is discarded); a live NOT NULL column with no default, not identity and
 * not generated, that the checkpoint lacks cannot be filled. A table that no longer exists is
 * reported with column `*`. Reports every summary table; callers filter to what they restore.
 */
export async function checkCompatibility(summary: ManifestSummary, query: SqlQuery): Promise<CompatibilityProblem[]> {
  const physical = new Map(summary.tables.map((t) => [t.model, physicalTable(t.model)]));
  const live = new Map<string, ColumnRow[]>();
  for (const row of await columnsOf(query, [...new Set(physical.values())])) {
    const list = live.get(row.table_name) ?? [];
    list.push(row);
    live.set(row.table_name, list);
  }
  const problems: CompatibilityProblem[] = [];
  for (const t of summary.tables) {
    const cols = live.get(physical.get(t.model)!);
    if (!cols?.length) {
      problems.push({ model: t.model, column: '*', problem: 'TABLE_MISSING' });
      continue;
    }
    const captured = new Set(t.columns);
    for (const c of cols) {
      if (captured.has(c.column_name)) continue;
      const fillable = c.is_nullable === 'YES' || c.column_default !== null || c.is_identity === 'YES' || c.is_generated === 'ALWAYS';
      if (!fillable) problems.push({ model: t.model, column: c.column_name, problem: 'NOT_NULL_WITHOUT_DEFAULT' });
    }
  }
  return problems;
}
