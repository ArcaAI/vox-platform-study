'use client';

import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { RunNodeRollup } from '../api/types';

/**
 * One node's attempt-sequence detail (Task 9 "Retries"). §2.1 / the Task 1
 * contract: there is no attempt column anywhere in `AgentTrajectoryStep` —
 * a consecutive run of same-`name` steps is folded into ONE group and the
 * grouping is ALWAYS labelled derived (`attemptGroupingIsDerived`), never
 * presented as authoritative. This renders every `attemptSeqs` entry as its
 * own chip (the trajectory `seq` values folded into the group, in attempt
 * order) so an operator can see exactly what was folded together.
 */
export function AttemptGroup({ rollup }: { rollup: RunNodeRollup }) {
  if (rollup.attemptCount <= 1) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{rollup.attemptCount} attempts</span>
        {rollup.attemptGroupingIsDerived ? (
          <span className="text-muted-foreground text-xs">
            (derived from consecutive same-type steps — no attempt marker is stamped by the interpreter)
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Trajectory step sequence numbers folded into this group">
        {rollup.attemptSeqs.map((seq, index) => (
          <Badge key={seq} variant="outline" className="font-mono text-xs">
            attempt {index + 1} &middot; seq {seq}
          </Badge>
        ))}
      </div>
    </div>
  );
}
