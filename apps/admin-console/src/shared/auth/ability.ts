/**
 * Client-side mirror of the gateway's CASL authorization semantics, hydrated
 * from POST /rbac/check/my-permissions. Drives menu visibility and
 * <RequirePermission> only — the server remains the enforcement point.
 */
export interface PermissionRule {
  /** CASL action; may be comma-joined when a rule carries multiple actions. */
  action: string;
  subject: string;
  conditions?: unknown;
}

/**
 * SUPER_ADMIN is the single elevated role. JWT aliases such as GLOBAL_ADMIN
 * are not accepted.
 */
export const ELEVATED_ROLES = ['SUPER_ADMIN'] as const;

/** The elevated cross-tenant set (see ELEVATED_ROLES). */
export function isElevated(roles: readonly string[] | null | undefined): boolean {
  return !!roles?.some((role) => (ELEVATED_ROLES as readonly string[]).includes(role));
}

function ruleActions(rule: PermissionRule): string[] {
  return rule.action
    .split(',')
    .map((action) => action.trim())
    .filter(Boolean);
}

/**
 * CASL-compatible check: `manage` grants every action on its subject and the
 * `all` subject matches every subject (so `manage:all` grants everything).
 * Conditions are intentionally ignored client-side (server enforces them).
 */
export function can(rules: readonly PermissionRule[] | null | undefined, action: string, subject: string): boolean {
  if (!rules?.length) return false;
  return rules.some((rule) => {
    if (rule.subject !== subject && rule.subject !== 'all') return false;
    const actions = ruleActions(rule);
    return actions.includes(action) || actions.includes('manage');
  });
}

/** True when ANY of the action/subject pairs is granted. */
export function canAny(rules: readonly PermissionRule[] | null | undefined, pairs: ReadonlyArray<readonly [string, string]>): boolean {
  return pairs.some(([action, subject]) => can(rules, action, subject));
}
