import type { SqlQuery } from '../contracts';
import { modelForTable } from './registry';

export interface FkEdge {
  child: string;
  parent: string;
  column: string;
}

const FK_SQL = `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, a.attname AS column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f' AND c.connamespace = 'core'::regnamespace`;

/** `core."ContextItem"` / `core.rounds` / `"ContextItem"` (core on the search_path) → bare table name. */
function bareTable(regclass: string): string {
  return regclass.replace(/^"?core"?\./, '').replace(/^"(.*)"$/, '$1').replace(/""/g, '"');
}

/** Foreign keys between tables of schema core, as model names. */
export async function loadFkEdges(query: SqlQuery): Promise<FkEdge[]> {
  const rows = await query<{ child: string; parent: string; column: string }>(FK_SQL);
  return rows.map((r) => ({
    child: modelForTable(bareTable(r.child)),
    parent: modelForTable(bareTable(r.parent)),
    column: r.column,
  }));
}

/**
 * Parents before children over the given models; self-edges ignored (a single INSERT…SELECT
 * satisfies them). Edges to models outside the set are ignored. Stable: among models with no
 * ordering constraint, input order is kept. A cycle between distinct tables throws.
 */
export function insertOrder(models: readonly string[], edges: readonly FkEdge[]): string[] {
  const set = new Set(models);
  const parents = new Map<string, Set<string>>(models.map((m) => [m, new Set<string>()]));
  for (const e of edges) {
    if (e.child === e.parent || !set.has(e.child) || !set.has(e.parent)) continue;
    parents.get(e.child)!.add(e.parent);
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < models.length) {
    const next = models.find((m) => !placed.has(m) && [...parents.get(m)!].every((p) => placed.has(p)));
    if (next === undefined) {
      const stuck = models.filter((m) => !placed.has(m));
      throw new Error(`checkpoint insert order: foreign-key cycle between ${stuck.join(', ')}`);
    }
    ordered.push(next);
    placed.add(next);
  }
  return ordered;
}
