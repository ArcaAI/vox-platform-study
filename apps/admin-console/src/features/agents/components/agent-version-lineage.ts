/**
 * TASK-672 — pure diff logic for the Lineage tab's `DepartmentAgentVersion`
 * history. `configSnapshot` is a small, flat, closed-shape document (the
 * seven TASK-659 loop-config fields — `role`/`subscribedKinds`/`writeScope`/
 * `goal`/`guardrailProfile`/`alwaysActions`/`neverActions`), so a per-field
 * before/after comparison is enough to show what changed between two
 * versions — no need for a server round trip or a line-level text diff
 * (there is no server diff endpoint for this resource, unlike PromptTemplate's
 * `GET :id/versions/:from/diff/:to`).
 */

export interface ConfigFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

/** Structural (not reference) equality over plain JSON values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every field present in EITHER snapshot whose value differs, sorted by
 * field name. A field missing from one snapshot compares as `undefined`.
 */
export function diffConfigSnapshots(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): ConfigFieldDiff[] {
  const beforeObj = before ?? {};
  const afterObj = after ?? {};
  const fields = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])].sort();
  return fields
    .filter((field) => !jsonEqual(beforeObj[field], afterObj[field]))
    .map((field) => ({ field, before: beforeObj[field], after: afterObj[field] }));
}

/** Renders a snapshot field value for display — compact JSON, or an em dash when absent. */
export function formatSnapshotValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
