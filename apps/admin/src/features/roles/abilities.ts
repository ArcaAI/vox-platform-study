/**
 * TASK-395 P1-3 (§5.1) — pure helpers for the Roles master-detail browser and the
 * policy permission matrix.
 *
 * Two client-side computations, both grounded in the REAL CASL model
 * (`Policy.rules`, `Role.parentRoleId`, `RolePolicy`):
 *
 * 1. **Permission matrix** (§5.1 `24b`) — a SUBJECTS × ACTIONS grid derived from a
 *    single policy's `rules` (allow ✓ / deny ✕ (`inverted`) / conditional •).
 * 2. **Effective-abilities preview** (§5.1 `24`, design-flagged TARGET) — aggregates
 *    the CASL rules of a role's **attached + inherited** policies (walking the
 *    `parentRoleId` chain) into a per-subject action summary. This is a client-side
 *    *simulation* of the union grant; the backend remains the enforcement source.
 */
import type { Policy, Role } from '@arcaai/vox';
import { rolePolicies, type RolePolicyRef, type RoleWithPolicies } from './types';

/** Concrete (non-`manage`) actions shown as the matrix columns / preview chips. */
export const MATRIX_ACTIONS = ['create', 'read', 'list', 'update', 'delete', 'archive', 'export'] as const;
export type MatrixAction = (typeof MATRIX_ACTIONS)[number];

export type CellState = 'allow' | 'deny' | 'conditional' | 'none';

/** A CASL rule reduced to the parts the matrix + preview need. */
export interface NormalizedRule {
  actions: string[];
  subjects: string[];
  hasConditions: boolean;
  inverted: boolean;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Best-effort normalize a policy's `rules: unknown[]` (CASL) into typed rules. */
export function normalizeRules(rules: unknown): NormalizedRule[] {
  if (!Array.isArray(rules)) return [];
  const out: NormalizedRule[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const actions = toStringArray(r.action);
    const subjects = toStringArray(r.subject);
    if (actions.length === 0 || subjects.length === 0) continue;
    const conditions = r.conditions;
    const hasConditions =
      Boolean(conditions) && typeof conditions === 'object' && !Array.isArray(conditions) && Object.keys(conditions as object).length > 0;
    out.push({ actions, subjects, hasConditions, inverted: r.inverted === true });
  }
  return out;
}

/** `manage` matches any action; otherwise an exact action match. */
function actionMatches(ruleActions: string[], action: string): boolean {
  return ruleActions.includes('manage') || ruleActions.includes(action);
}

/** `all` matches any subject; otherwise an exact subject match. */
function subjectMatches(ruleSubjects: string[], subject: string): boolean {
  return ruleSubjects.includes('all') || ruleSubjects.includes(subject);
}

/** Distinct subjects present in the rule-set, sorted with the `all` wildcard first. */
export function ruleSubjects(rules: NormalizedRule[]): string[] {
  const set = new Set<string>();
  for (const r of rules) for (const s of r.subjects) set.add(s);
  return [...set].sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b)));
}

/**
 * Matrix cell for a (subject, action) pair. CASL precedence: a matching `inverted`
 * ("cannot") rule wins → `deny`; else a conditional allow → `conditional`; else a
 * plain allow → `allow`; else `none`.
 */
export function cellState(rules: NormalizedRule[], subject: string, action: string): CellState {
  let allow = false;
  let conditional = false;
  let deny = false;
  for (const r of rules) {
    if (!subjectMatches(r.subjects, subject) || !actionMatches(r.actions, action)) continue;
    if (r.inverted) {
      deny = true;
    } else {
      allow = true;
      if (r.hasConditions) conditional = true;
    }
  }
  if (deny) return 'deny';
  if (conditional) return 'conditional';
  if (allow) return 'allow';
  return 'none';
}

export interface RuleSummary {
  total: number;
  allow: number;
  deny: number;
  conditional: number;
}

/** Header counts for the matrix, e.g. "13 rules · 3 deny". */
export function ruleSummary(rules: NormalizedRule[]): RuleSummary {
  let allow = 0;
  let deny = 0;
  let conditional = 0;
  for (const r of rules) {
    if (r.inverted) deny += 1;
    else {
      allow += 1;
      if (r.hasConditions) conditional += 1;
    }
  }
  return { total: rules.length, allow, deny, conditional };
}

// ── Inheritance tree ─────────────────────────────────────────────────────────

export interface RoleTreeNode {
  role: RoleWithPolicies;
  depth: number;
  children: RoleTreeNode[];
}

function roleSortKey(role: Role): string {
  const external = (role as RoleWithPolicies & { externalName?: unknown }).externalName;
  return (typeof external === 'string' && external.trim()) || role.name;
}

/**
 * Build the parent→child inheritance forest. Roots are roles with no
 * `parentRoleId` (or whose parent is absent from the set). Siblings sort by
 * display name; cycles are broken defensively (a visited role is not re-nested).
 */
export function buildRoleTree(roles: Role[]): RoleTreeNode[] {
  const byId = new Map<string, Role>();
  for (const r of roles) byId.set(r.id, r);
  const childrenOf = new Map<string | null, Role[]>();
  for (const r of roles) {
    const parent = typeof r.parentRoleId === 'string' && byId.has(r.parentRoleId) ? r.parentRoleId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(r);
    else childrenOf.set(parent, [r]);
  }

  const visited = new Set<string>();
  const build = (role: Role, depth: number): RoleTreeNode => {
    visited.add(role.id);
    const kids = (childrenOf.get(role.id) ?? [])
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => roleSortKey(a).localeCompare(roleSortKey(b)))
      .map((c) => build(c, depth + 1));
    return { role: role as RoleWithPolicies, depth, children: kids };
  };

  return (childrenOf.get(null) ?? []).sort((a, b) => roleSortKey(a).localeCompare(roleSortKey(b))).map((r) => build(r, 0));
}

/** Depth-first flatten of the forest into ordered rows (for indented rendering). */
export function flattenRoleTree(nodes: RoleTreeNode[]): { role: RoleWithPolicies; depth: number }[] {
  const rows: { role: RoleWithPolicies; depth: number }[] = [];
  const walk = (node: RoleTreeNode) => {
    rows.push({ role: node.role, depth: node.depth });
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return rows;
}

/** The parent role (or null) for a role, resolved within the roster. */
export function parentRole(role: Role, roles: Role[]): RoleWithPolicies | null {
  if (typeof role.parentRoleId !== 'string') return null;
  return (roles.find((r) => r.id === role.parentRoleId) as RoleWithPolicies | undefined) ?? null;
}

/** Direct children of a role within the roster (for the "Extended by" note). */
export function childRoles(role: Role, roles: Role[]): RoleWithPolicies[] {
  return roles.filter((r) => r.parentRoleId === role.id) as RoleWithPolicies[];
}

// ── Effective abilities (attached + inherited) ─────────────────────────────────

export interface PolicyRefWithSource extends RolePolicyRef {
  /** The role that contributes this policy (`null` = the selected role itself). */
  inheritedFrom: string | null;
}

/**
 * Every policy ref that applies to a role: the role's own attached policies plus
 * those of every ancestor (walking `parentRoleId`), deduped by policy id. Own
 * policies take precedence over inherited when the same id appears twice.
 */
export function collectPolicyRefs(role: Role, roles: Role[]): PolicyRefWithSource[] {
  const byId = new Map<string, Role>();
  for (const r of roles) byId.set(r.id, r);

  const seen = new Set<string>();
  const refs: PolicyRefWithSource[] = [];
  const add = (list: RolePolicyRef[], from: string | null) => {
    for (const ref of list) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      refs.push({ ...ref, inheritedFrom: from });
    }
  };

  add(rolePolicies(role), null);

  const visited = new Set<string>([role.id]);
  let current = typeof role.parentRoleId === 'string' ? byId.get(role.parentRoleId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    add(rolePolicies(current), roleSortKey(current));
    current = typeof current.parentRoleId === 'string' ? byId.get(current.parentRoleId) : undefined;
  }
  return refs;
}

export interface EffectiveAbility {
  subject: string;
  /** `manage` grant → all actions on the subject. */
  manage: boolean;
  /** Concrete allowed actions, ordered by `MATRIX_ACTIONS`. */
  actions: string[];
  /** Any contributing allow carried CASL `conditions` (scoped, e.g. own records). */
  conditional: boolean;
  /** Explicitly denied (`inverted`) actions; `manage` = denies everything. */
  denied: string[];
  /** Names of the policies that contributed this subject (for provenance). */
  sources: string[];
}

interface AbilityAccumulator {
  manage: boolean;
  actions: Set<string>;
  conditional: boolean;
  denied: Set<string>;
  sources: Set<string>;
}

/**
 * Compute a role's effective abilities by unioning the CASL rules of its attached
 * + inherited policies into a per-subject action summary. Client-side simulation
 * (design TARGET); returns subjects sorted with the `all` wildcard first.
 */
export function effectiveAbilities(role: Role, roles: Role[], policies: Policy[]): EffectiveAbility[] {
  const policiesById = new Map<string, Policy>();
  for (const p of policies) policiesById.set(p.id, p);

  const bySubject = new Map<string, AbilityAccumulator>();
  const ensure = (subject: string): AbilityAccumulator => {
    let acc = bySubject.get(subject);
    if (!acc) {
      acc = { manage: false, actions: new Set(), conditional: false, denied: new Set(), sources: new Set() };
      bySubject.set(subject, acc);
    }
    return acc;
  };

  for (const ref of collectPolicyRefs(role, roles)) {
    const policy = policiesById.get(ref.id);
    if (!policy) continue;
    for (const rule of normalizeRules(policy.rules)) {
      for (const subject of rule.subjects) {
        const acc = ensure(subject);
        acc.sources.add(policy.name);
        for (const action of rule.actions) {
          if (rule.inverted) {
            acc.denied.add(action);
          } else if (action === 'manage') {
            acc.manage = true;
            if (rule.hasConditions) acc.conditional = true;
          } else {
            acc.actions.add(action);
            if (rule.hasConditions) acc.conditional = true;
          }
        }
      }
    }
  }

  const order = (a: string) => {
    const i = (MATRIX_ACTIONS as readonly string[]).indexOf(a);
    return i === -1 ? MATRIX_ACTIONS.length : i;
  };

  return [...bySubject.entries()]
    .filter(([, acc]) => acc.manage || acc.actions.size > 0 || acc.denied.size > 0)
    .map(([subject, acc]) => ({
      subject,
      manage: acc.manage,
      actions: [...acc.actions].sort((a, b) => order(a) - order(b)),
      conditional: acc.conditional,
      denied: [...acc.denied].sort((a, b) => order(a) - order(b)),
      sources: [...acc.sources].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => (a.subject === 'all' ? -1 : b.subject === 'all' ? 1 : a.subject.localeCompare(b.subject)));
}
