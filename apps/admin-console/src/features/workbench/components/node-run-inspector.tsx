'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconCircleMinus, IconCircleX, IconClockExclamation, IconLoader2 } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber } from '@/shared/format';
import { useRunTrace } from '../api/hooks';
import type { RunNodeRollup, RunTrace } from '../api/types';

/** Never color-only (rule 11 §7) — a distinct icon pairs with every status label, mirroring
 *  `features/workflow-runs/components/node-run-badge.tsx`'s own set (built fresh here per the
 *  cross-feature rule, not imported — flagged  as a promotion candidate). */
const STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; Icon: typeof IconCircleCheck }> = {
  STARTED: { label: 'In progress', variant: 'secondary', Icon: IconLoader2 },
  OK: { label: 'OK', variant: 'default', Icon: IconCircleCheck },
  ERROR: { label: 'Error', variant: 'destructive', Icon: IconCircleX },
  SKIPPED: { label: 'Skipped', variant: 'outline', Icon: IconCircleMinus },
  TIMEOUT: { label: 'Timed out', variant: 'outline', Icon: IconClockExclamation },
};

function statusMeta(status: string) {
  return STATUS_META[status.toUpperCase()] ?? { label: status, variant: 'outline' as const, Icon: IconCircleMinus };
}

/**
 * Per-node inspection: for the run's current trace, list each node group and
 * open a `DetailDrawer` with timing/status. Reuses `admin/workflow-runs/:runId/trace` verbatim
 *  — a sandbox run is a `WorkflowRun` row like any other. Payloads resolve through
 * the claim-check indirection the interpreter provides, and `AgentTrajectoryStepResponse`
 * strips `payloadRef` entirely under the PHI posture (mirrors
 * `features/workflow-runs/components/run-node-detail-drawer.tsx`'s own finding) — honoured here
 * with the SAME explicit "payload not available" message (pitfall 1: never an empty box that
 * reads as "no output").
 */
/**
 * Run-level outcome. Rendered ABOVE the per-node list because a degraded node is
 * invisible in that list by construction (see `RunTrace.run` in `../api/types`), so a reader who
 * only scanned node badges would conclude a degraded run was clean.
 *
 * Absent counts render nothing at all rather than `0` — a fabricated zero is worse than silence.
 */
function RunOutcomeSummary({ run }: { run: RunTrace['run'] }) {
  const failed = typeof run.failedNodeCount === 'number' ? run.failedNodeCount : null;
  const degraded = typeof run.degradedNodeCount === 'number' ? run.degradedNodeCount : null;
  if (failed === null && degraded === null) return null;

  const clean = (failed ?? 0) === 0 && (degraded ?? 0) === 0;
  const parts = [failed !== null ? `${failed} failed` : null, degraded !== null ? `${degraded} degraded` : null].filter(Boolean).join(' · ');

  return (
    <div
      className={
        clean
          ? 'text-muted-foreground flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm'
          : 'border-destructive/40 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm'
      }
    >
      {/* Never colour alone (rule 11 §7/§11): the icon and the words carry the meaning. */}
      {clean ? <IconCircleCheck aria-hidden className="size-4" /> : <IconAlertTriangle aria-hidden className="text-destructive size-4" />}
      <span>{clean ? 'No failed or degraded nodes.' : parts}</span>
      {typeof run.nodeCount === 'number' ? <span className="text-muted-foreground">of {run.nodeCount} nodes</span> : null}
      {run.firstErrorCode ? (
        <span className="text-muted-foreground">
          first error <code className="font-mono">{run.firstErrorCode}</code>
        </span>
      ) : null}
    </div>
  );
}

export function NodeRunInspector({ runId }: { runId: string | null }) {
  const traceQuery = useRunTrace(runId);
  const [selected, setSelected] = useState<RunNodeRollup | null>(null);

  if (!runId) {
    return <p className="text-muted-foreground text-sm">Start a run to inspect its nodes.</p>;
  }

  if (traceQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  const trace = traceQuery.data;
  if (!trace || trace.nodes.length === 0) {
    return <p className="text-muted-foreground text-sm">{trace?.tracePruned ? 'This run has no retained trace.' : 'No nodes recorded yet.'}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <RunOutcomeSummary run={trace.run} />
      <ul className="flex flex-col gap-1">
        {trace.nodes.map((node) => {
          const meta = statusMeta(node.status);
          return (
            <li key={`${node.nodeType}-${node.order}`}>
              <button
                type="button"
                onClick={() => setSelected(node)}
                className="hover:bg-muted focus-visible:ring-ring flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="min-w-0 truncate font-mono text-xs">{node.nodeType}</span>
                <Badge variant={meta.variant} className="shrink-0 gap-1">
                  <meta.Icon aria-hidden className="size-3" />
                  {meta.label}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
      {trace.truncated ? <p className="text-muted-foreground text-xs">Showing a prefix of this run — the full trace exceeded the read cap.</p> : null}

      <DetailDrawer
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.nodeType ?? ''}
        meta={selected ? <code className="font-mono">order {selected.order}</code> : null}
      >
        {selected ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Started</dt>
              <dd>{formatDateTime(selected.startedAt)}</dd>
              <dt className="text-muted-foreground">Ended</dt>
              <dd>{selected.endedAt ? formatDateTime(selected.endedAt) : 'In progress'}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{selected.durationMs !== null ? `${formatNumber(selected.durationMs)} ms` : '—'}</dd>
              {selected.errorCode ? (
                <>
                  <dt className="text-muted-foreground">Error code</dt>
                  <dd className="font-mono">{selected.errorCode}</dd>
                </>
              ) : null}
            </dl>
            <div className="rounded-md border border-dashed p-3 text-sm">
              <p className="text-muted-foreground">
                Payload not available. Step payloads are stored by reference under a PHI posture and are never exposed through this read model.
              </p>
            </div>
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  );
}
