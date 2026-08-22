'use client';

import { IconAlertTriangle, IconClockExclamation } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { formatNumber } from '@/shared/format';
import type { RunNodeRollup, WorkflowRun } from '../api/types';

/**
 * Run-level failure/degradation/timeout summary (Task 9). Every claim here
 * is honesty-constrained by README pitfalls 5–7:
 *
 *  - Timeouts render as their OWN callout, never folded into "failed" —
 *    design.md: "Timeout force-stops that node only", so a run with a
 *    TIMEOUT node is not necessarily a failed run (pitfall 5).
 *  - Degradation is `WorkflowRun.degradedNodeCount`, a COUNT/FLAG never a
 *    run status (pitfall 6) — "Degraded" never appears as a status badge.
 *  - A rollup ERROR status cannot be told apart from a degraded node using
 *    the trajectory alone (the DTO's own doc comment) — this panel reports
 *    the run-level counts as the authoritative source, and lists node-level
 *    ERROR rollups honestly as "error" without asserting which is which.
 */
export function FailurePanel({ run, nodes }: { run: WorkflowRun; nodes: RunNodeRollup[] }) {
  const timeoutNodes = nodes.filter((node) => node.status.toUpperCase() === 'TIMEOUT');
  const errorNodes = nodes.filter((node) => node.status.toUpperCase() === 'ERROR');
  const hasAnything = run.failedNodeCount > 0 || run.degradedNodeCount > 0 || timeoutNodes.length > 0 || Boolean(run.firstErrorCode);

  if (!hasAnything) return null;

  return (
    <div className="flex flex-col gap-2">
      {run.failedNodeCount > 0 || errorNodes.length > 0 ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>
            {formatNumber(run.failedNodeCount || errorNodes.length)} node{run.failedNodeCount === 1 ? '' : 's'} failed
          </AlertTitle>
          <AlertDescription>
            {run.firstErrorCode ? (
              <span>
                First error code: <code className="font-mono">{run.firstErrorCode}</code>
              </span>
            ) : null}
            {errorNodes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {errorNodes.map((node) => (
                  <Badge key={`${node.nodeType}-${node.order}`} variant="destructive" className="text-xs">
                    {node.nodeType}
                  </Badge>
                ))}
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {run.degradedNodeCount > 0 ? (
        <Alert>
          <IconAlertTriangle aria-hidden />
          <AlertTitle>
            {formatNumber(run.degradedNodeCount)} node{run.degradedNodeCount === 1 ? '' : 's'} degraded
          </AlertTitle>
          <AlertDescription>
            A degraded node produced a MARKED nothing, not an empty one — the run continued, but this node&rsquo;s output should not be treated as
            complete.
          </AlertDescription>
        </Alert>
      ) : null}

      {timeoutNodes.length > 0 ? (
        <Alert>
          <IconClockExclamation aria-hidden />
          <AlertTitle>
            {formatNumber(timeoutNodes.length)} node{timeoutNodes.length === 1 ? '' : 's'} timed out
          </AlertTitle>
          <AlertDescription>
            A timeout force-stops that node only — it does not by itself mean the run failed.
            <div className="flex flex-wrap gap-1">
              {timeoutNodes.map((node) => (
                <Badge key={`${node.nodeType}-${node.order}`} variant="secondary" className="text-xs">
                  {node.nodeType}
                </Badge>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
