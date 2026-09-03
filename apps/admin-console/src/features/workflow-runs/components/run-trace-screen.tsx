'use client';

import { useMemo, useState } from 'react';
import { IconHistory, IconLayoutGrid, IconList, IconRoute } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { WorkflowCanvas, type WorkflowCanvasNodeProblem } from '@arcaai/ui/components/workflow-canvas';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useRunLiveEvents } from '../api/live-events';
import { useRunTrace, useWorkflowDefinitionVersion } from '../api/hooks';
import { isNonTerminalRunStatus } from '../api/polling';
import type { RunNodeRollup, WorkflowGraph } from '../api/types';
import { humanizeNodeType, toCanvasGraph } from '../lib/graph-layout';
import { problemForLiveNode, problemForRollup } from '../lib/node-problem';
import { correlateRollupsToGraphNodes } from '../lib/rollup-correlation';
import { FailurePanel } from './failure-panel';
import { GateApprovalPanel } from './gate-approval-panel';
import { NodeRunBadge } from './node-run-badge';
import { RunLiveActivity } from './run-live-activity';
import { RunNodeDetailDrawer } from './run-node-detail-drawer';
import { RunReplayScrubber } from './run-replay-scrubber';
import { RunStatusBadge } from './run-status-badge';
import { RunTraceListView } from './run-trace-list-view';
import { TracePrunedState } from './trace-pruned-state';

const VIEW_VALUES = ['canvas', 'list'] as const;
type View = (typeof VIEW_VALUES)[number];

/** Stable selection key for a rollup — its correlation to a graph node id is best-effort (lib/rollup-correlation), so selection is keyed off the rollup itself, not off a graph node id that might not exist. */
function rollupKey(rollup: Pick<RunNodeRollup, 'nodeType' | 'order'>): string {
  return `${rollup.nodeType}#${rollup.order}`;
}

/** Selection key for a graph node that has no matching rollup — kept distinguishable from a rollup key by prefix. */
function nodeOnlyKey(graphNodeId: string): string {
  return `node:${graphNodeId}`;
}

function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  return typeof value === 'object' && value !== null && Array.isArray((value as { nodes?: unknown }).nodes);
}

function TraceBody({ runId }: { runId: string }) {
  // Fed back by the SSE hook below once it knows its own status — see that hook's own doc
  // comment for why this two-hook wiring can't be collapsed into one call.
  const [streamDegraded, setStreamDegraded] = useState(false);
  const traceQuery = useRunTrace(runId, streamDegraded);
  const trace = traceQuery.data;
  const isLiveRun = isNonTerminalRunStatus(trace?.run.status);
  const definitionQuery = useWorkflowDefinitionVersion(trace?.run.workflowVersionId ?? null);
  const [viewParam, setViewParam] = useQueryState('view', parseAsString.withDefault('canvas'));
  const view: View = (VIEW_VALUES as readonly string[]).includes(viewParam) ? (viewParam as View) : 'canvas';
  const [selectedKey, setSelectedKey] = useQueryState('node', parseAsString);

  // Replay/scrub — reads only the durable REST trace already
  // fetched above; `replayStep` is the count of `orderedNodes` REVEALED so far. Only offered
  // for a terminal run (a live run already has its own live front — scrubbing a run that is
  // still moving underneath you is a different feature this ticket doesn't ask for).
  const orderedNodes = useMemo(() => [...(trace?.nodes ?? [])].sort((a, b) => a.order - b.order), [trace]);
  const [replayActive, setReplayActive] = useState(false);
  const [replayStep, setReplayStep] = useState(0);
  const effectiveRollups = useMemo(
    () => (replayActive ? orderedNodes.slice(0, replayStep) : (trace?.nodes ?? [])),
    [replayActive, orderedNodes, replayStep, trace],
  );

  const live = useRunLiveEvents({
    runId,
    // `WorkflowRun.workflowSlug` — unknown until the trace resolves.
    slug: trace?.run.workflowSlug ?? null,
    enabled: isLiveRun,
    onResnapshot: () => void traceQuery.refetch(),
  });
  // Adjusted DURING RENDER, not in an effect (same idiom as `live-events.ts`'s reset-on-runId —
  // react-hooks/set-state-in-effect forbids a synchronous setState in an effect body, and this
  // is the sanctioned "derive one piece of state from another" exception to that rule).
  const [streamStatusSeen, setStreamStatusSeen] = useState(live.status);
  if (live.status !== streamStatusSeen) {
    setStreamStatusSeen(live.status);
    setStreamDegraded(live.status === 'error');
  }

  const graph = definitionQuery.data && isWorkflowGraph(definitionQuery.data.graph) ? definitionQuery.data.graph : null;
  const canvasGraph = useMemo(() => (graph ? toCanvasGraph(graph) : null), [graph]);
  const correlation = useMemo(
    () => (graph ? correlateRollupsToGraphNodes(graph.nodes, effectiveRollups) : new Map<string, RunNodeRollup>()),
    [graph, effectiveRollups],
  );
  // Per-graph-node canvas border (lane C step 6): the durable rollup first, then the
  // LIVE control frame for that exact `nodeId` overrides it — the live frame can arrive before
  // the next REST re-snapshot resolves, and a retry that just started must clear a stale ERROR
  // border from the previous attempt. Replay never consults live state (a completed run's live
  // hook is disabled anyway — see `enabled: isLiveRun` above).
  const nodeProblemById = useMemo(() => {
    const map = new Map<string, WorkflowCanvasNodeProblem>();
    for (const [nodeId, rollup] of correlation) {
      const problem = problemForRollup(rollup);
      if (problem) map.set(nodeId, problem);
    }
    if (!replayActive) {
      for (const [nodeId, payload] of live.nodeStatusById) {
        const problem = problemForLiveNode(payload);
        if (problem) map.set(nodeId, problem);
        else map.delete(nodeId);
      }
    }
    return map;
  }, [correlation, live.nodeStatusById, replayActive]);
  const canvasNodes = useMemo(
    () => canvasGraph?.nodes.map((node) => (nodeProblemById.has(node.id) ? { ...node, problem: nodeProblemById.get(node.id) } : node)) ?? [],
    [canvasGraph, nodeProblemById],
  );
  // Inverse of `correlation`, keyed the same way selection is keyed, so a
  // canvas click (graph node id) and a list click (rollup) resolve to the
  // same selection state either way.
  const graphNodeIdByRollupKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const [graphNodeId, rollup] of correlation) map.set(rollupKey(rollup), graphNodeId);
    return map;
  }, [correlation]);
  const rollupsByKey = useMemo(() => new Map((trace?.nodes ?? []).map((rollup) => [rollupKey(rollup), rollup])), [trace]);

  const selectedRollup = selectedKey ? (rollupsByKey.get(selectedKey) ?? null) : null;
  const selectedGraphNodeId = selectedRollup
    ? (graphNodeIdByRollupKey.get(selectedKey as string) ?? null)
    : selectedKey?.startsWith('node:')
      ? selectedKey.slice('node:'.length)
      : null;
  const selectedNodeType = selectedRollup?.nodeType ?? canvasGraph?.nodes.find((node) => node.id === selectedGraphNodeId)?.type ?? null;

  function selectGraphNode(graphNodeId: string | null) {
    if (!graphNodeId) return void setSelectedKey(null);
    const rollup = correlation.get(graphNodeId);
    void setSelectedKey(rollup ? rollupKey(rollup) : nodeOnlyKey(graphNodeId));
  }

  if (traceQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (traceQuery.isError || !trace) {
    return <ErrorState error={traceQuery.error} onRetry={() => void traceQuery.refetch()} />;
  }

  const { run, nodes, truncated, tracePruned } = trace;
  const isLive = isLiveRun;

  return (
    <ScreenTemplate
      contentMode={tracePruned ? 'scroll' : 'fill'}
      header={
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {run.definitionName}
              <RunStatusBadge status={run.status} />
            </span>
          }
          meta={
            <>
              <span>
                v{run.workflowVersionNumber} &middot; {run.workflowSlug}
              </span>
              <span>{run.trigger}</span>
              <span title={formatDateTime(run.startedAt)}>Started {formatRelativeTime(run.startedAt)}</span>
              {run.durationMs !== null ? <span>{formatNumber(run.durationMs)} ms</span> : null}
              {run.isSandbox ? <span className="text-warning-strong font-medium">Sandbox run</span> : null}
            </>
          }
          actions={
            !tracePruned ? (
              <div className="flex items-center gap-1 rounded-md border p-0.5">
                <Button
                  type="button"
                  variant={view === 'canvas' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={view === 'canvas'}
                  onClick={() => void setViewParam(null)}
                >
                  <IconLayoutGrid aria-hidden />
                  Canvas
                </Button>
                <Button
                  type="button"
                  variant={view === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={view === 'list'}
                  onClick={() => void setViewParam('list')}
                >
                  <IconList aria-hidden />
                  List
                </Button>
              </div>
            ) : undefined
          }
        />
      }
      statusBanner={
        <div className="flex flex-col gap-2">
          {/* The gate sits ABOVE the failure summary: a run waiting on a human is an action the
              clinician must take now, whereas the failure panel is a report on what already
              happened. `GateApprovalPanel` renders nothing unless the gate is genuinely
              waiting. */}
          <GateApprovalPanel run={run} />
          <FailurePanel run={run} nodes={nodes} />
          <RunLiveActivity status={live.status} events={live.events} />
        </div>
      }
      toolbar={
        !isLive && !tracePruned && nodes.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant={replayActive ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={replayActive}
              onClick={() => {
                if (replayActive) {
                  setReplayActive(false);
                } else {
                  setReplayActive(true);
                  setReplayStep(orderedNodes.length);
                }
              }}
            >
              <IconHistory aria-hidden />
              {replayActive ? 'Exit replay' : 'Replay this run'}
            </Button>
            {replayActive ? (
              <RunReplayScrubber
                totalSteps={orderedNodes.length}
                step={replayStep}
                onStepChange={setReplayStep}
                stepLabel={replayStep > 0 && replayStep <= orderedNodes.length ? humanizeNodeType(orderedNodes[replayStep - 1].nodeType) : null}
              />
            ) : null}
          </div>
        ) : undefined
      }
      footer={
        <StatusFooter
          start={<span>{isLive ? 'Live · polling while running' : 'Terminal run — not polling'}</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/workflow-runs/:runId/trace{truncated ? ' (truncated)' : ''}
            </span>
          }
        />
      }
    >
      {tracePruned ? (
        <TracePrunedState startedAt={run.startedAt} />
      ) : definitionQuery.isLoading ? (
        <Skeleton className="h-full w-full" />
      ) : definitionQuery.isError ? (
        <ErrorState error={definitionQuery.error} onRetry={() => void definitionQuery.refetch()} />
      ) : !canvasGraph ? (
        <EmptyState icon={IconRoute} title="No graph available" description="The pinned definition version did not return a readable graph." />
      ) : nodes.length === 0 ? (
        <EmptyState
          icon={IconRoute}
          title="No steps recorded yet"
          description={isLive ? 'This run is still starting — steps will appear as nodes execute.' : 'This run recorded no trajectory steps.'}
        />
      ) : view === 'list' ? (
        // `contentMode="fill"` hands the FULL region height to this child and
        // expects it to own its own scroll (rule 11 §1) — the canvas does via
        // React Flow's internal pane; the list needs an explicit scroll
        // container of its own so it never grows the page instead.
        <div className="h-full min-h-0 overflow-y-auto">
          <RunTraceListView nodes={replayActive ? effectiveRollups : nodes} onSelect={(rollup) => void setSelectedKey(rollupKey(rollup))} />
        </div>
      ) : (
        <WorkflowCanvas
          nodes={canvasNodes}
          edges={canvasGraph.edges}
          readOnly
          selectedNodeId={selectedGraphNodeId}
          onSelect={selectGraphNode}
          overlay={(node) => {
            const rollup = correlation.get(node.id);
            return rollup ? <NodeRunBadge rollup={rollup} /> : null;
          }}
          aria-label={`Run trace for ${run.definitionName} v${run.workflowVersionNumber}, pinned to the immutable published version`}
        />
      )}

      <RunNodeDetailDrawer
        open={!!selectedKey}
        nodeType={selectedNodeType}
        rollup={selectedRollup}
        liveOutputPreview={selectedGraphNodeId ? live.liveOutputByNodeId.get(selectedGraphNodeId) : undefined}
        onOpenChange={(open) => !open && void setSelectedKey(null)}
      />
    </ScreenTemplate>
  );
}

/** Frame N.1 — Run trace (canvas overlay), tier 30-49. */
export function RunTraceScreen({ runId }: { runId: string }) {
  return (
    <WorkingTenantGate
      title="Run trace"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-runs/{runId}/trace
        </span>
      }
      description="Workflow runs are tenant-scoped. Pick a working tenant from the top-bar switcher to load this run."
    >
      <TraceBody runId={runId} />
    </WorkingTenantGate>
  );
}
