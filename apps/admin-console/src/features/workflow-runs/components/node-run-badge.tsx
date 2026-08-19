'use client';

import { IconAlertTriangle, IconCircleCheck, IconCircleMinus, IconCircleX, IconClockExclamation, IconLoader2 } from '@tabler/icons-react';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber } from '@/shared/format';
import type { RunNodeRollup, TrajectoryStepStatus } from '../api/types';

/**
 * Per-node overlay badge (Task 8's canvas overlay AND Task 8's `?view=list`
 * peer). Never color-only (rule 11 §7): every state pairs a distinct glyph
 * with its text label — `IconCircleCheck` vs `IconCircleX` vs
 * `IconClockExclamation` remain distinguishable without color.
 *
 * `TIMEOUT` renders as its own state, never folded into ERROR (README
 * pitfall 5 — design.md: "Timeout force-stops that node only", not the run).
 * `degraded` (from `WorkflowRun.degradedNodeCount`, never derivable from a
 * single rollup — the DTO's own doc comment: a trajectory ERROR row cannot
 * be told apart from a degraded one) is an OPTIONAL extra flag layered on
 * top of an ERROR/OK status, never a status value of its own.
 */
const STATUS_META: Record<string, { label: string; role: StatusColorRole; Icon: typeof IconCircleCheck }> = {
  STARTED: { label: 'In progress', role: 'primary', Icon: IconLoader2 },
  OK: { label: 'OK', role: 'success', Icon: IconCircleCheck },
  ERROR: { label: 'Error', role: 'destructive', Icon: IconCircleX },
  SKIPPED: { label: 'Skipped', role: 'neutral', Icon: IconCircleMinus },
  TIMEOUT: { label: 'Timed out', role: 'warning', Icon: IconClockExclamation },
};

function statusMeta(status: TrajectoryStepStatus) {
  return STATUS_META[status.toUpperCase()] ?? { label: status, role: 'neutral' as StatusColorRole, Icon: IconAlertTriangle };
}

export interface NodeRunBadgeProps {
  rollup: RunNodeRollup;
  /** Set when this node's rollup falls within the run's `degradedNodeCount` (README: "a marked nothing, never an empty one"). */
  degraded?: boolean;
  className?: string;
}

export function NodeRunBadge({ rollup, degraded, className }: NodeRunBadgeProps) {
  const meta = statusMeta(rollup.status);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge
          label={meta.label}
          colorRole={meta.role}
          icon={<meta.Icon aria-hidden className={rollup.status.toUpperCase() === 'STARTED' ? 'animate-spin' : undefined} />}
        />
        {degraded ? (
          <StatusBadge label="Degraded" colorRole="warning" icon={<IconAlertTriangle aria-hidden />} />
        ) : null}
        {rollup.attemptCount > 1 ? (
          <span className="text-muted-foreground text-2xs">
            {formatNumber(rollup.attemptCount)} attempts{rollup.attemptGroupingIsDerived ? ' (derived)' : ''}
          </span>
        ) : null}
      </div>
      {rollup.durationMs !== null ? <p className="text-muted-foreground mt-0.5 text-2xs">{formatNumber(rollup.durationMs)} ms</p> : null}
    </div>
  );
}
