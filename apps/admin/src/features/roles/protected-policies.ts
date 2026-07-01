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
 * FLAG: this is name-based. If a deployment renames these seeded policies, both
 * the backend guard and this constant must be updated together.
 */

/** Minimal policy shape the guard needs (name is enough to identify the set). */
export interface ProtectedPolicyLike {
    name?: string | null;
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
 * Whether a policy is in the anti-lockout protected set. Matches by exact `name`
 * (case-sensitive, mirroring the seed + backend guard).
 */
export function isProtectedSystemPolicy(policy: ProtectedPolicyLike | null | undefined): boolean {
    const name = policy?.name;
    return typeof name === 'string' && (PROTECTED_SYSTEM_POLICY_NAMES as readonly string[]).includes(name);
}
