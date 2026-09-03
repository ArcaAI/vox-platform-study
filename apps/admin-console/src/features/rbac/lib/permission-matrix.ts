/**
 * Permission-matrix derivation (build spec
 *
 * A role's effective permissions are a DERIVED, read-only view computed from
 * its attached policies. Each policy carries CASL rules
 * (`{ action, subject, conditions?, fields?, inverted? }`); the role↔policy
 * attachment carries a numeric `priority`. This module folds those rules into a
 * `resource × action` grid of cell states.
 *
 * Semantics (v1):
 *  - Columns are the fixed CRUD + manage set; `manage` (and CASL wildcards
 *    `all`/`*`/`manage`) imply every column.
 *  - Policies are evaluated in **priority order (ascending number = higher
 *    precedence, evaluated first)**; the first rule that matches a
 *    `(subject, action)` cell decides it (first-match).
 *  - A matching `inverted: true` rule denies → `none` (deny wins at its
 *    priority). An allow from a `GLOBAL`-scope policy reads as `inherited`
 *    (system-wide). An allow carrying `conditions`/`fields` reads as
 *    `conditional`. Any other allow reads as `granted`. No match → `none`.
 *
 * Editing stays in the Policies tab (attach/detach); inline cell toggles are
 * explicitly out of scope for v1.
 */

import type { PolicyRule, PolicyScope } from '../api/types';

export type CellState = 'granted' | 'inherited' | 'conditional' | 'none';

export type MatrixAction = 'read' | 'create' | 'update' | 'delete' | 'manage';

/** Column order (artboard 1d): Read · Create · Update · Delete · Manage. */
export const MATRIX_ACTIONS: readonly MatrixAction[] = ['read', 'create', 'update', 'delete', 'manage'];

export const MATRIX_ACTION_LABELS: Record<MatrixAction, string> = {
  read: 'Read',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  manage: 'Manage',
};

/** A policy joined with its attachment priority — the derivation input. */
export interface MatrixPolicyInput {
  id: string;
  name: string;
  scope: PolicyScope;
  isProtected?: boolean;
  /** Attachment priority; lower number = higher precedence (evaluated first). */
  priority: number;
  rules: PolicyRule[];
}

export interface MatrixRow {
  subject: string;
  label: string;
  cells: Record<MatrixAction, CellState>;
}

export interface LegendEntry {
  state: CellState;
  glyph: string;
  label: string;
}

export interface PermissionMatrix {
  rows: MatrixRow[];
  legend: LegendEntry[];
}

/**
 * Curated resource rows in display order (build spec Subjects appearing in
 * attached policies but absent here are appended below, first-seen order.
 */
const CURATED_SUBJECTS: readonly { subject: string; label: string }[] = [
  { subject: 'Consultation', label: 'Consultation' },
  { subject: 'Patient', label: 'Patient record' },
  { subject: 'Department', label: 'Department' },
  { subject: 'PromptTemplate', label: 'Prompt template' },
  { subject: 'Pipeline', label: 'Audio pipeline' },
  { subject: 'WritingStyle', label: 'DNA writing style' },
  { subject: 'Tenant', label: 'Tenant settings' },
];

export const MATRIX_LEGEND: readonly LegendEntry[] = [
  { state: 'granted', glyph: '✓', label: 'Granted' },
  { state: 'inherited', glyph: '◐', label: 'Inherited from a system policy' },
  { state: 'conditional', glyph: '✓', label: 'Granted with conditions' },
  { state: 'none', glyph: '—', label: 'Not granted' },
];

/** CASL wildcards that mean "every subject" / "every action". */
const WILDCARDS = new Set(['all', '*', 'manage']);

/** Normalize a CASL action string onto a matrix column (aliases collapsed). */
const ACTION_ALIASES: Record<string, MatrixAction> = {
  read: 'read',
  list: 'read',
  view: 'read',
  get: 'read',
  index: 'read',
  create: 'create',
  add: 'create',
  update: 'update',
  edit: 'update',
  patch: 'update',
  modify: 'update',
  delete: 'delete',
  remove: 'delete',
  destroy: 'delete',
  manage: 'manage',
};

/** CASL `action`/`subject` are `string | string[]` — coerce to a trimmed list. */
function toList(value: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeAction(action: string): MatrixAction | 'manage' | null {
  const key = action.trim().toLowerCase();
  if (WILDCARDS.has(key)) return 'manage';
  return ACTION_ALIASES[key] ?? null;
}

/** Humanize an unknown CASL subject ("AuditLog" -> "Audit log"). */
function humanizeSubject(subject: string): string {
  const spaced = subject
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return subject;
  const lower = spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  return lower;
}

function isWildcardSubject(subject: string): boolean {
  return WILDCARDS.has(subject.trim().toLowerCase());
}

/**
 * Does a rule match this (subject, column)? A rule matches the column when its
 * normalized action equals the column OR the rule grants `manage` (implies all).
 */
function ruleMatches(rule: PolicyRule, subject: string, action: MatrixAction): boolean {
  const subjectMatches = toList(rule.subject).some((ruleSubject) => {
    const trimmed = ruleSubject.trim();
    return isWildcardSubject(trimmed) || trimmed === subject;
  });
  if (!subjectMatches) return false;
  return toList(rule.action).some((ruleAction) => {
    const normalized = normalizeAction(ruleAction);
    return normalized !== null && (normalized === action || normalized === 'manage');
  });
}

function allowState(policy: MatrixPolicyInput, rule: PolicyRule): CellState {
  if (policy.scope === 'GLOBAL') return 'inherited';
  const conditional = (rule.conditions && Object.keys(rule.conditions).length > 0) || (rule.fields && rule.fields.length > 0);
  return conditional ? 'conditional' : 'granted';
}

/** Resolve one cell by first-match across priority-ordered policies. */
function resolveCell(policies: MatrixPolicyInput[], subject: string, action: MatrixAction): CellState {
  for (const policy of policies) {
    for (const rule of policy.rules ?? []) {
      if (!ruleMatches(rule, subject, action)) continue;
      if (rule.inverted) return 'none';
      return allowState(policy, rule);
    }
  }
  return 'none';
}

/** Build the ordered row catalog: curated subjects first, then unknowns. */
function buildRowCatalog(policies: MatrixPolicyInput[]): { subject: string; label: string }[] {
  const rows: { subject: string; label: string }[] = [...CURATED_SUBJECTS];
  const seen = new Set(CURATED_SUBJECTS.map((entry) => entry.subject));
  for (const policy of policies) {
    for (const rule of policy.rules ?? []) {
      for (const rawSubject of toList(rule.subject)) {
        const subject = rawSubject.trim();
        if (!subject || isWildcardSubject(subject) || seen.has(subject)) continue;
        seen.add(subject);
        rows.push({ subject, label: humanizeSubject(subject) });
      }
    }
  }
  return rows;
}

/**
 * Derive the permission matrix for a role from its attached policies. Policies
 * are sorted ascending by `priority` (ties keep input order) so the lowest
 * number is evaluated first (highest precedence).
 */
export function derivePermissionMatrix(policies: MatrixPolicyInput[]): PermissionMatrix {
  const ordered = [...policies].sort((a, b) => a.priority - b.priority);
  const catalog = buildRowCatalog(ordered);

  const rows: MatrixRow[] = catalog.map(({ subject, label }) => {
    const cells = {} as Record<MatrixAction, CellState>;
    for (const action of MATRIX_ACTIONS) {
      cells[action] = resolveCell(ordered, subject, action);
    }
    return { subject, label, cells };
  });

  return { rows, legend: [...MATRIX_LEGEND] };
}
