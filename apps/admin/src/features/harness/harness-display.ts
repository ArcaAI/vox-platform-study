/**
 * TASK-407 — pure display helpers for the Harness surface. Design source:
 * `unbuilt-super-admin-surfaces.md` §2 "Harness" (spec-only): sub-tabs
 * Policy · Eval runs · Audit trail · Gate queue; Temporal-backed views must
 * degrade honestly when the harness service (`:8866`) is down.
 */

import type { HarnessPolicySource } from '@arcaai/vox';

export type HarnessColorRole = 'hope' | 'info' | 'success' | 'warning' | 'destructive' | 'neutral';

/** "24h" / "1h 30m" / "1m 30s" / "45s"; em-dash for missing/negative. */
export function formatSeconds(seconds?: number | null): string {
  if (seconds == null || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const SOURCE_LABELS: Record<HarnessPolicySource, string> = {
  tenant: 'Tenant override',
  'system-default': 'Platform default',
  'code-default': 'Code default',
};

const SOURCE_ROLES: Record<HarnessPolicySource, HarnessColorRole> = {
  tenant: 'hope',
  'system-default': 'info',
  'code-default': 'neutral',
};

/** Where the effective policy resolved from (tenant row → global → code). */
export function policySourceLabel(source: HarnessPolicySource): string {
  return SOURCE_LABELS[source];
}

export function policySourceRole(source: HarnessPolicySource): HarnessColorRole {
  return SOURCE_ROLES[source];
}

const WORKFLOW_ROLES: Record<string, HarnessColorRole> = {
  QUEUED: 'info', // EvalRun shares this map (QUEUED/RUNNING/COMPLETED/FAILED)
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'destructive',
  TERMINATED: 'destructive',
  CANCELED: 'neutral',
  TIMED_OUT: 'warning',
  CONTINUED_AS_NEW: 'info',
};

/** Temporal workflow / eval-run status → pill color role. */
export function workflowStatusRole(status?: string | null): HarnessColorRole {
  if (!status) return 'neutral';
  return WORKFLOW_ROLES[status.toUpperCase()] ?? 'neutral';
}

/** WORM audit hash-chain verdict → integrity badge model. */
export function chainVerdict(verification: { valid: boolean; brokenAtIndex: number | null } | null | undefined): {
  label: string;
  colorRole: HarnessColorRole;
} {
  if (!verification) return { label: 'Not verified', colorRole: 'neutral' };
  if (verification.valid) return { label: 'Chain verified', colorRole: 'success' };
  return { label: `Chain broken at #${verification.brokenAtIndex ?? '?'}`, colorRole: 'destructive' };
}
