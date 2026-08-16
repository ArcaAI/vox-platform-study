'use client';

import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber } from '@/shared/format';
import { AttemptGroup } from './attempt-group';
import { humanizeNodeType } from '../lib/graph-layout';
import { NodeRunBadge } from './node-run-badge';
import type { RunNodeRollup } from '../api/types';

/**
 * Node-level detail for the run trace (Task 8). `payloadRef` is a reference
 * under a PHI posture (`agent-trajectory.prisma`) — Task 5's own honesty
 * note recorded that `AgentTrajectoryStepResponse` strips it entirely rather
 * than merely redacting it, so there is nothing this drawer can resolve
 * today; it says so explicitly (README pitfall 7) rather than rendering a
 * misleading blank section.
 */
export function RunNodeDetailDrawer({
  open,
  nodeType,
  rollup,
  degraded,
  onOpenChange,
}: {
  open: boolean;
  /** The authored graph node's `type`, shown even when no rollup matched it (node never reached / no trace). */
  nodeType: string | null;
  rollup: RunNodeRollup | null;
  degraded?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={nodeType ? humanizeNodeType(nodeType) : ''}
      meta={nodeType ? <code className="font-mono">{nodeType}</code> : null}
    >
      {rollup ? (
        <div className="flex flex-col gap-4">
          <NodeRunBadge rollup={rollup} degraded={degraded} />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Started</dt>
            <dd>{formatDateTime(rollup.startedAt)}</dd>
            <dt className="text-muted-foreground">Ended</dt>
            <dd>{rollup.endedAt ? formatDateTime(rollup.endedAt) : 'In progress'}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{rollup.durationMs !== null ? `${formatNumber(rollup.durationMs)} ms` : '—'}</dd>
            {rollup.errorCode ? (
              <>
                <dt className="text-muted-foreground">Error code</dt>
                <dd className="font-mono">{rollup.errorCode}</dd>
              </>
            ) : null}
          </dl>

          <AttemptGroup rollup={rollup} />

          <div className="rounded-md border border-dashed p-3 text-sm">
            <p className="text-muted-foreground">
              Payload not available. Step payloads are stored by reference under a PHI posture and are never exposed through this read model.
            </p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No trajectory step was recorded for this node in this run &mdash; it was not reached, or its correlation to a specific step could not be
          determined (node identity is derived from type + order; see the trace&rsquo;s known limitation).
        </p>
      )}
    </DetailDrawer>
  );
}
