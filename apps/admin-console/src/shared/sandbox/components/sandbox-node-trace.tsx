'use client';

import { IconAlertTriangle, IconCircleCheck, IconCircleMinus, IconCircleX, IconClockExclamation, IconLoader2 } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatNumber } from '@/shared/format';
import { useRunTrace } from '../api/hooks';
import type { RunNodeRollup, RunTrace } from '../api/types';

/** Never colour-only (rule 11 §7) — a distinct icon pairs with every status label. Moved from
 *  `features/workbench/components/node-run-inspector.tsx` (TASK-893). */
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
 * Run-level outcome, shown ABOVE the per-node list because a degraded node is invisible in that
 * list by construction (see `RunTrace.run` in `../api/types`) — a reader who only scanned node
 * badges would conclude a degraded run was clean. Absent counts render nothing at all rather than
 * `0` — a fabricated zero is worse than silence. Moved verbatim from
 * `features/workbench/components/node-run-inspector.tsx` (TASK-893).
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

function NodeDetailFields({ node }: { node: RunNodeRollup }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatDateTime(node.startedAt)}</dd>
        <dt className="text-muted-foreground">Ended</dt>
        <dd>{node.endedAt ? formatDateTime(node.endedAt) : 'In progress'}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{node.durationMs !== null ? `${formatNumber(node.durationMs)} ms` : '—'}</dd>
        {node.errorCode ? (
          <>
            <dt className="text-muted-foreground">Error code</dt>
            <dd className="font-mono">{node.errorCode}</dd>
          </>
        ) : null}
      </dl>
      <div className="rounded-md border border-dashed p-3 text-sm">
        <p className="text-muted-foreground">
          Payload not available. Step payloads are stored by reference under a PHI posture and are never exposed through this read model.
        </p>
      </div>
    </div>
  );
}

/** A compact row, not the old `NodeRunInspector`'s click-to-`DetailDrawer` flow — this renders
 *  inside an already-open inspector tab, so a second slide-over would nest awkwardly. */
function NodeRow({ node }: { node: RunNodeRollup }) {
  const meta = statusMeta(node.status);
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <span className="min-w-0 truncate font-mono text-xs">{node.nodeType}</span>
      <span className="flex shrink-0 items-center gap-2">
        {node.durationMs !== null ? <span className="text-muted-foreground text-xs">{formatNumber(node.durationMs)} ms</span> : null}
        <Badge variant={meta.variant} className="gap-1">
          <meta.Icon aria-hidden className="size-3" />
          {meta.label}
        </Badge>
      </span>
    </li>
  );
}

/**
 * Contract C (INTERFACES.md §5) — one node's input/output/trace for the inspector's Run tab.
 * Moved from `features/workbench/components/node-run-inspector.tsx` (TASK-893), narrowed from a
 * whole-run list-plus-drawer to a single selected node's detail (the Studio's canvas is now the
 * node picker; this component answers "what happened to the node I have selected").
 *
 * **Same structural gap as `useSandboxNodeStates`** (`../api/hooks.ts` — read that doc comment
 * first): the trace endpoint does not carry a graph node id today, only `nodeType` + execution
 * `order`, so this component cannot yet filter the trace down to exactly `nodeId`. Rather than
 * guess (and risk showing the WRONG node's outcome, which is worse than showing none), it looks
 * for a forward-compatible exact `nodeId` match and, failing that — which is every trace today —
 * falls back to the full run's per-node list with an explicit, honest label that it is a
 * fallback. "Input/output" payloads are never available regardless (PHI posture, see
 * `NodeDetailFields` below): step payloads are stored by reference and this read model never
 * discloses them.
 */
export function SandboxNodeTrace({ runId, nodeId }: { runId: string | null; nodeId: string | null }) {
  // Nothing renders until BOTH are set (the guards below), so there is nothing to fetch until
  // then either — pass `null` through to `useRunTrace` (which gates its own query on
  // `enabled: !!runId`) rather than firing a trace read no paint will use.
  const traceQuery = useRunTrace(nodeId ? runId : null);

  if (!runId) {
    return <p className="text-muted-foreground text-sm">Start a sandbox run to inspect its nodes.</p>;
  }
  if (!nodeId) {
    return <p className="text-muted-foreground text-sm">Select a node on the canvas to inspect its run trace.</p>;
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

  const matched = trace.nodes.find((node) => node.nodeId === nodeId);

  if (matched) {
    return <NodeDetailFields node={matched} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        This sandbox run can&apos;t attribute trace rows to the selected node yet — showing the full run instead.
      </p>
      <RunOutcomeSummary run={trace.run} />
      <ul className="flex flex-col gap-1">
        {trace.nodes.map((node) => (
          <NodeRow key={`${node.nodeType}-${node.order}`} node={node} />
        ))}
      </ul>
      {trace.truncated ? <p className="text-muted-foreground text-xs">Showing a prefix of this run — the full trace exceeded the read cap.</p> : null}
    </div>
  );
}
