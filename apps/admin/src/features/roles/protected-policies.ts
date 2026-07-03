/**
 * TASK-391 #22 (R3) — client mirror of the backend policy anti-lockout guard.
 *
 * TASK-390 hardened `PolicyService` so the two seeded, system-critical GLOBAL
 * policies that grant super-admins their access **cannot** be deleted, disabled,
 * scope-changed, or have their load-bearing rules stripped — removing them would
 * lock every super-admin out platform-wide. The server refuses those mutations
 * with a `ForbiddenException` (source of truth).
 *
 * This constant mirrors that protected set **by name** (matching
 * `PolicyService.PROTECTED_SYSTEM_POLICIES` and the `01-policy.ts` seed) so the
 * console can render the protection up front — a `Protected` badge + a disabled
 * Delete — instead of offering an action the API would reject (defense in depth;
 * the console prefers to hide/disable what the server would 4xx).
 *
 * TASK-409 — the server now returns an authoritative `isProtected` marker on
 * every policy (rename-proof, seed-managed, read-only). The check below
 * prefers that marker; the name list remains as the legacy fallback for API
 * responses that predate the column.
 */

/** Minimal policy shape the guard needs. */
export interface ProtectedPolicyLike {
  name?: string | null;
  /** TASK-409 — server-authoritative anti-lockout marker. */
  isProtected?: boolean | null;
}

/**
 * The seeded, system-critical GLOBAL policies protected from destructive edits:
 * - `system-full-access` — the `manage:all` grant behind super-admin access.
 * - `rbac-system-manage` — the `manage:Role`/`Policy`/`RolePolicy` grant behind RBAC administration.
 */
export const PROTECTED_SYSTEM_POLICY_NAMES = ['system-full-access', 'rbac-system-manage'] as const;

export type ProtectedSystemPolicyName = (typeof PROTECTED_SYSTEM_POLICY_NAMES)[number];

/** Human-readable reason shown on the disabled Delete affordance + Protected badge. */
export const PROTECTED_POLICY_REASON =
  'Protected system policy — cannot be deleted or disabled (anti-lockout). Renaming and adding rules are still allowed.';

/**
 * Whether a policy is in the anti-lockout protected set.
 *
 * TASK-409 — prefers the server-authoritative `isProtected` marker; falls back
 * to the exact-`name` match (case-sensitive, mirroring the seed + backend
 * guard) for payloads that predate the column.
 */
export function isProtectedSystemPolicy(policy: ProtectedPolicyLike | null | undefined): boolean {
  if (policy?.isProtected === true) return true;
  const name = policy?.name;
  return typeof name === 'string' && (PROTECTED_SYSTEM_POLICY_NAMES as readonly string[]).includes(name);
}
