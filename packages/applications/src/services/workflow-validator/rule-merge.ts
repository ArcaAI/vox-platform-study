/**
 * The one-way-strictness merge: SYSTEM register ∪ tenant additions
 *
 * PURE — no I/O, no throwing (the `departmentAgent/constants.ts` split: the pure
 * cross-field checks live beside the repository-backed half, never inside it).
 *
 * Ownership rule, from `workflow-invariant-rule.prisma`'s header: SYSTEM-tenant
 * rows are the platform invariant register made executable. A tenant row may ADD
 * a rule, and may RAISE the severity of a SYSTEM rule sharing its `ruleId`, but
 * may never lower one, never remove one, and never redefine what a SYSTEM rule
 * CHECKS. The service's write path enforces the same property at authoring time;
 * this enforces it at READ time, so a row that predates (or slipped past) the
 * write gate still cannot weaken a platform safety rule.
 */
import type { DraftWorkflowRule } from '@arcaai/workflow-contract';

/**
 * A rule row resolved for evaluation. Structurally a `DraftWorkflowRule` minus
 * its `status: 'DRAFT'` literal (a DB-sourced row is not a code-catalogue draft),
 * plus the provenance the merge needs.
 */
export type ResolvedRule = Omit<DraftWorkflowRule, 'status'> & {
  /** Which tier authored the row — SYSTEM register vs a tenant addition. */
  tenantId: string;
  /** The re-validation sweep's trigger; `ruleSetVersion` is the max across the merged set. */
  ruleVersion: number;
};

/** ERROR is strictly stricter than WARNING. The only two severities (`WorkflowRuleSeverity`). */
function isStricter(candidate: ResolvedRule['severity'], incumbent: ResolvedRule['severity']): boolean {
  return candidate === 'ERROR' && incumbent === 'WARNING';
}

/**
 * Merge the SYSTEM register with a tenant's own rows.
 *
 * - A tenant `ruleId` with no SYSTEM counterpart is added verbatim.
 * - A tenant `ruleId` that SHADOWS a SYSTEM rule contributes its severity ONLY
 *   when that severity is stricter; everything else about the rule (predicate
 *   type and config, palette, register refs) stays the SYSTEM row's, because a
 *   tenant may tighten a platform rule but never redefine what it checks — an
 *   emptied `predicateConfig` would otherwise be a disabled rule wearing an
 *   ERROR badge.
 * - Output is ordered by `ruleId` so a report's finding order is deterministic
 *   across processes (the same reason the compiler hashes canonical JSON).
 */
export function mergeRuleSets(systemRules: readonly ResolvedRule[], tenantRules: readonly ResolvedRule[]): ResolvedRule[] {
  const merged = new Map<string, ResolvedRule>();

  for (const rule of systemRules) {
    merged.set(rule.ruleId, rule);
  }

  for (const rule of tenantRules) {
    const incumbent = merged.get(rule.ruleId);
    if (!incumbent) {
      merged.set(rule.ruleId, rule);
      continue;
    }
    // Shadows a SYSTEM rule: take the stricter severity, keep everything else.
    merged.set(rule.ruleId, {
      ...incumbent,
      severity: isStricter(rule.severity, incumbent.severity) ? rule.severity : incumbent.severity,
      // The sweep must notice a tenant's tightening too, so the effective
      // version is the higher of the two.
      ruleVersion: Math.max(incumbent.ruleVersion, rule.ruleVersion),
    });
  }

  return [...merged.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}
