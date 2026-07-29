/**
 * Live-refresh predicates for the harness workflows surface. Temporal
 * visibility is a snapshot, so the list and the selected detail poll on a fixed
 * interval WHILE anything they show is still live, and stop once everything is
 * terminal (or the tab is backgrounded). `RUNNING` is the only non-terminal
 * status — COMPLETED / FAILED / CANCELED / TERMINATED / TIMED_OUT /
 * CONTINUED_AS_NEW are all done.
 *
 * These are exported as pure functions so the `refetchInterval` rule can be
 * asserted deterministically (fake timers race TanStack Query's scheduler).
 */

import type { HarnessWorkflowStatus, HarnessWorkflowSummary } from './types';

/** Poll cadence for a live workflow list / detail. */
export const WORKFLOW_POLL_INTERVAL_MS = 5000;

/** True only for the single non-terminal Temporal status (`RUNNING`). */
export function isNonTerminal(status: HarnessWorkflowStatus | string | null | undefined): boolean {
  return typeof status === 'string' && status.toUpperCase() === 'RUNNING';
}

/** The tab is foreground (or there is no `document`, e.g. SSR). */
function isForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * `refetchInterval` for the workflow list: 5s while any visible row is live and
 * the tab is foreground, otherwise `false` (stop polling).
 */
export function workflowsRefetchInterval(rows: Pick<HarnessWorkflowSummary, 'status'>[] | undefined): number | false {
  if (!isForeground()) return false;
  return (rows ?? []).some((row) => isNonTerminal(row.status)) ? WORKFLOW_POLL_INTERVAL_MS : false;
}

/**
 * `refetchInterval` for the selected workflow detail: 5s while its run is live
 * and the tab is foreground, otherwise `false`.
 */
export function workflowRefetchInterval(status: HarnessWorkflowStatus | string | null | undefined): number | false {
  if (!isForeground()) return false;
  return isNonTerminal(status) ? WORKFLOW_POLL_INTERVAL_MS : false;
}
