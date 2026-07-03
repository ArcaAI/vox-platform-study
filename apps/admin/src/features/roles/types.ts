import type { Role } from '@arcaai/vox';

/**
 * A policy attached to a role. The RBAC roles endpoint (`/admin/rbac/roles`)
 * returns a `policies: [{ id, name, priority }]` array on every role (see
 * `apps/api/.../roles.controller.ts#toResponse`), but the SDK `Role` type only
 * declares `[key: string]: unknown`, so the admin app reads it through this
 * local view type.
 */
export interface RolePolicyRef {
  id: string;
  name: string;
  priority?: number;
}

export type RoleWithPolicies = Role & { policies?: RolePolicyRef[]; isSystemRole?: boolean };

/** Safely read a role's attached policies (empty array when absent). */
export function rolePolicies(role: Role): RolePolicyRef[] {
  const p = (role as RoleWithPolicies).policies;
  return Array.isArray(p) ? p.filter((x): x is RolePolicyRef => Boolean(x && x.id)) : [];
}
