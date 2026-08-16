/**
 * Live-refresh predicates for the runs surface (mirrors
 * `features/harness-ops/api/polling.ts` exactly — same reasoning: the run
 * list/detail is a snapshot, so it polls on a fixed interval WHILE anything
 * shown is still live, and stops once everything is terminal or the tab is
 * backgrounded). `RUNNING` is the only non-terminal `WorkflowRunStatus`
 * (`packages/domains/src/enums/generated/WorkflowRunStatus.ts`) —
 * `COMPLETED | FAILED | CANCELED | TIMED_OUT` are all done. No `DEGRADED`
 * value exists (README pitfall 6): degradation is a count on the row, never
 * a status this predicate needs to know about.
 */
import type { WorkflowRun, WorkflowRunStatus } from './types';

export const RUN_POLL_INTERVAL_MS = 5000;

export function isNonTerminalRunStatus(status: WorkflowRunStatus | string | null | undefined): boolean {
  return typeof status === 'string' && status.toUpperCase() === 'RUNNING';
}

function isForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** `refetchInterval` for the runs list: 5s while any loaded row is live and the tab is foreground. */
export function runsListRefetchInterval(rows: Pick<WorkflowRun, 'status'>[] | undefined): number | false {
  if (!isForeground()) return false;
  return (rows ?? []).some((row) => isNonTerminalRunStatus(row.status)) ? RUN_POLL_INTERVAL_MS : false;
}

/** `refetchInterval` for a single run/trace: 5s while it is live and the tab is foreground. */
export function runRefetchInterval(status: WorkflowRunStatus | string | null | undefined): number | false {
  if (!isForeground()) return false;
  return isNonTerminalRunStatus(status) ? RUN_POLL_INTERVAL_MS : false;
}
