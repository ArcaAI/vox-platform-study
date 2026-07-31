import { resolveDepartmentKey } from './dept-templates';

/** The minimal Department shape the matcher needs (satisfied by `DepartmentEntity`). */
export interface DepartmentLike {
  id: string;
  code?: string | null;
  name?: string | null;
}

function norm(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Match a free-form department string (the v1 `department` / session-metadata
 * value) to one of the TENANT's real `Department` rows so the compat shim can
 * resolve that department's governed instruction template (TASK-592).
 *
 * Precedence, first hit wins:
 *   1. exact `code`  (the DB business key is `(tenantId, code)`) — case-insensitive;
 *   2. exact `name`  — case-insensitive;
 *   3. v1 synonym-canonical-key match — `resolveDepartmentKey` maps both the needle
 *      and each row's name/code to one of the 7 canonical keys, so "Medicine"
 *      matches a row named "General Medicine" and "Ortho" matches "Orthopedics".
 *
 * Returns `null` when nothing matches — the caller then falls back to the static
 * dept×visit field-set steering, preserving the pre-TASK-592 behavior.
 */
export function matchTenantDepartment<T extends DepartmentLike>(departments: readonly T[], needle?: string | null): T | null {
  const n = norm(needle);
  if (!n) return null;

  const byCode = departments.find((d) => norm(d.code) === n);
  if (byCode) return byCode;

  const byName = departments.find((d) => norm(d.name) === n);
  if (byName) return byName;

  const needleKey = resolveDepartmentKey(needle);
  if (needleKey) {
    const bySynonym = departments.find((d) => resolveDepartmentKey(d.name) === needleKey || resolveDepartmentKey(d.code) === needleKey);
    if (bySynonym) return bySynonym;
  }

  return null;
}
