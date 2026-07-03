/**
 * TASK-311 AC-2 — `PolicyEntityMapper` is the single recorded site that
 * projects a raw Prisma `Policy` row onto the structural `PolicyRecord`
 * shape `PolicyService` returns to its controller. Today the projection
 * is a strict subset of the Prisma row (no field renames, no
 * computations); the mapper still exists as the contract pin-point so a
 * future schema column does not silently leak through the service layer.
 */

/** Public record shape that `PolicyService` returns. Structurally a
 *  subset of the Prisma `Policy` row — DOES NOT include `_version`,
 *  `metaData`, or any `resourceStatusUpdatedBy` audit columns. */
export interface PolicyRecord {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  rules: unknown;
  resourceStatus: string;
  /** TASK-409 — server-authoritative anti-lockout marker (read-only via API). */
  isProtected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal structural shape required for the mapper input. Declared
 *  structurally (not as `Prisma.PolicyGetPayload<{}>`) so unit tests can
 *  build rows with `as never` and avoid the heavy Prisma generic. */
export interface PolicyRowLike {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  rules: unknown;
  resourceStatus: string;
  /** Optional so legacy test fixtures without the TASK-409 column still map. */
  isProtected?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function mapPolicyRowToRecord(row: PolicyRowLike): PolicyRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    rules: row.rules,
    resourceStatus: row.resourceStatus,
    isProtected: row.isProtected ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
