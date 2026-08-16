'use client';

import { IconClockExclamation } from '@tabler/icons-react';
import { EmptyState } from '@/shared/state/empty-state';
import { formatDateTime } from '@/shared/format';

/**
 * README pitfall 3 / Task 9: a run row can outlive its trace — steps are
 * pruned by `AgentTrajectoryRetentionService` (default 30 days, opt-in
 * `agentic.trajectory.enabled`). When `RunTraceResponse.tracePruned` is true
 * (computed server-side from the SAME AppSettings keys the retention cron
 * reads — never a client-side guess), this renders an EXPLICIT "pruned"
 * state naming the retention setting, never an empty timeline that reads as
 * "nothing happened".
 */
export function TracePrunedState({ startedAt }: { startedAt: string }) {
  return (
    <EmptyState
      icon={IconClockExclamation}
      title="Trace pruned by retention"
      description={
        <>
          This run started {formatDateTime(startedAt, 'datetime')}, before the effective{' '}
          <code className="font-mono">agentic.trajectory.retentionDays</code> window — its step-level trajectory was hard-deleted by the nightly
          retention prune. The run record itself (status, timing, node counts) is unaffected; only the per-node trace detail is gone.
        </>
      }
    />
  );
}
