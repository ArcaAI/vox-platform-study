'use client';

/**
 * lane C — the run-trace screen's PUSH transport. Replaces the 5 s
 * `refetchInterval` poll (`polling.ts`'s own doc: "the run list/detail is a
 * snapshot, so it polls... while anything shown is still live") with the
 * ticket-authenticated SSE stream lane A built
 * (`GET workflows/:slug/runs/:runId/stream`). The shared `useEventStream`
 * hook (`@/shared/streams`) owns ticket minting + reconnect — reused
 * verbatim, exactly like `useTaskStream` and `JobStreamPanel` already do for
 * their own streams (F-21: reuse, don't reinvent).
 *
 * This hook does NOT reconstruct the rollup itself from raw events — that
 * would duplicate the server's grouping/attempt logic
 * (`WorkflowRunService.getRunTrace`) on the client. Instead every frame is a
 * signal: the caller re-fetches the durable REST trace (`useRunTrace`) on the
 * control frames that actually changed something, which is exactly the
 * "re-snapshot on a `workflow.run.progress` frame" contract the ticket
 * describes. What this hook DOES keep client-side is the ordered event LOG
 * (for the live event/tool-call feed) and a per-node-id status map built
 * from the EXACT `nodeId` a live event carries — see `WorkflowNodeEventPayload`'s
 * own doc comment for why that beats the trace's best-effort correlation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { workflowRunStreamPath, workflowRunStreamScope } from './client';
import type { WorkflowNodeEventPayload, WorkflowRunEventEnvelope, WorkflowTokenDeltaPayload } from './types';

export const WORKFLOW_RUN_PROGRESS = 'workflow.run.progress';
export const WORKFLOW_RUN_COMPLETED = 'workflow.run.completed';
export const WORKFLOW_NODE_STARTED = 'workflow.node.started';
export const WORKFLOW_NODE_COMPLETED = 'workflow.node.completed';
export const WORKFLOW_NODE_FAILED = 'workflow.node.failed';
export const WORKFLOW_LOOP_ITERATION = 'workflow.loop.iteration';
export const WORKFLOW_GUARDRAIL_VERDICT = 'workflow.guardrail.verdict';
/** The DELTA lane (`WorkflowTokenDeltaPayload`) — never mirrored through Temporal, and never
 *  appended to the control-event log below; see `tokensByNodeId`'s own doc comment. */
export const WORKFLOW_TOKEN_DELTA = 'workflow.token.delta';

/**
* Every type name this hook subscribes to — kept as one list so the `eventNames`
 *  passed to `useEventStream` and the switch below can never drift apart. All SEVEN
 * wire event types the run stream can carry (lane C contract reconciliation
 *  see `WorkflowRunEventType` in `api/types.ts`). 
 */
const RUN_STREAM_EVENT_NAMES = [
  WORKFLOW_RUN_PROGRESS,
  WORKFLOW_RUN_COMPLETED,
  WORKFLOW_NODE_STARTED,
  WORKFLOW_NODE_COMPLETED,
  WORKFLOW_NODE_FAILED,
  WORKFLOW_LOOP_ITERATION,
  WORKFLOW_GUARDRAIL_VERDICT,
  WORKFLOW_TOKEN_DELTA,
] as const;

/** Frames whose arrival means the durable trace has moved and is worth re-fetching. Deliberately
 *  excludes `WORKFLOW_TOKEN_DELTA` — a delta changes nothing the REST trace rollup tracks (it
 *  isn't a node boundary), so re-snapshotting on it would turn a high-volume stream into a
 *  high-volume REST poll and defeat the point of the push transport. */
const RESNAPSHOT_ON = new Set<string>([WORKFLOW_RUN_PROGRESS, WORKFLOW_RUN_COMPLETED, WORKFLOW_NODE_COMPLETED, WORKFLOW_NODE_FAILED]);

/** Append-only log cap — mirrors `JobStreamPanel`'s `MAX_EVENTS` (frame 35 precedent). */
const MAX_EVENTS = 200;

/** Per-node accumulated delta text cap (characters). A node streaming a long deliberation must
 *  not grow this hook's state unboundedly; kept as a live PREVIEW, never the durable output —
 *  the durable value is whatever the trace/step payload eventually resolves to. */
const MAX_LIVE_OUTPUT_CHARS = 4_000;

export interface RunLiveEvent {
  type: string;
  occurredAt: string;
  payload: WorkflowNodeEventPayload;
}

export interface RunLiveEventsState {
  status: StreamStatus;
  /** Ordered log of every control frame seen on the CURRENT connection. */
  events: RunLiveEvent[];
  /** Latest payload per exact authored-graph `nodeId`, from `workflow.node.*` frames. */
  nodeStatusById: Map<string, WorkflowNodeEventPayload>;
  /**
   * Live-accumulated `workflow.token.delta` text per exact `nodeId`, in arrival order,
   * capped at {@link MAX_LIVE_OUTPUT_CHARS}. This is the DELTA lane's one surfaced affordance
   * (ticket step 6/8: "what makes the canvas live rather than a status poller") — a PREVIEW
   * only, cleared on `workflow.node.started` for that node (a new attempt must not show the
   * previous attempt's trailing text) and never treated as the durable output.
   */
  liveOutputByNodeId: Map<string, string>;
  reopen: () => void;
}

function parseEnvelope(data: string): WorkflowRunEventEnvelope<WorkflowNodeEventPayload | WorkflowTokenDeltaPayload> | null {
  try {
    return JSON.parse(data) as WorkflowRunEventEnvelope<WorkflowNodeEventPayload | WorkflowTokenDeltaPayload>;
  } catch {
    return null;
  }
}

function isTokenDeltaPayload(type: string, payload: unknown): payload is WorkflowTokenDeltaPayload {
  return type === WORKFLOW_TOKEN_DELTA && typeof payload === 'object' && payload !== null && typeof (payload as WorkflowTokenDeltaPayload).text === 'string';
}

export function useRunLiveEvents(options: {
  runId: string | null;
  /** `WorkflowRun.workflowSlug` — unknown until the first trace fetch resolves. */
  slug: string | null;
  enabled: boolean;
  /** Fired for every frame that should trigger a trace re-fetch; the caller owns the
   *  actual React Query invalidation so this hook never depends on the query client. */
  onResnapshot?: () => void;
}): RunLiveEventsState {
  const { runId, slug, enabled, onResnapshot } = options;
  const [events, setEvents] = useState<RunLiveEvent[]>([]);
  const [nodeStatusById, setNodeStatusById] = useState<Map<string, WorkflowNodeEventPayload>>(new Map());
  const [liveOutputByNodeId, setLiveOutputByNodeId] = useState<Map<string, string>>(new Map());

  const onResnapshotRef = useRef(onResnapshot);
  useEffect(() => {
    onResnapshotRef.current = onResnapshot;
  }, [onResnapshot]);

  // A remount (new runId) must not carry the previous run's log/status map forward. Adjusted
  // DURING RENDER (React's documented "resetting state when a prop changes" idiom) rather than
  // in an effect — an effect body may not call setState synchronously (react-hooks/set-state-in-
  // effect), and this is exactly the sanctioned exception to that rule.
  const [resetForRunId, setResetForRunId] = useState(runId);
  if (runId !== resetForRunId) {
    setResetForRunId(runId);
    setEvents([]);
    setNodeStatusById(new Map());
    setLiveOutputByNodeId(new Map());
  }

  const path = runId && slug ? workflowRunStreamPath(slug, runId) : null;
  const scope = runId ? workflowRunStreamScope(runId) : null;

  const onEvent = useCallback((type: string, data: string) => {
    const envelope = parseEnvelope(data);
    if (!envelope) return;
    const payload = envelope.payload ?? {};

    // The DELTA lane branches off entirely: it never joins the control-event log (it would
    // flood the 200-frame cap in seconds) and never triggers a REST re-snapshot (RESNAPSHOT_ON
    // deliberately omits it — see that constant's own doc comment).
    if (isTokenDeltaPayload(type, payload)) {
      const { nodeId, text } = payload;
      setLiveOutputByNodeId((current) => {
        const next = new Map(current);
        const accumulated = (next.get(nodeId) ?? '') + text;
        next.set(nodeId, accumulated.length > MAX_LIVE_OUTPUT_CHARS ? accumulated.slice(-MAX_LIVE_OUTPUT_CHARS) : accumulated);
        return next;
      });
      return;
    }

    const nodePayload = payload as WorkflowNodeEventPayload;
    setEvents((current) => [...current.slice(-(MAX_EVENTS - 1)), { type, occurredAt: envelope.occurredAt, payload: nodePayload }]);

    if (nodePayload.nodeId && (type === WORKFLOW_NODE_STARTED || type === WORKFLOW_NODE_COMPLETED || type === WORKFLOW_NODE_FAILED)) {
      const nodeId = nodePayload.nodeId;
      setNodeStatusById((current) => {
        const next = new Map(current);
        next.set(nodeId, nodePayload);
        return next;
      });
      // A fresh attempt starting must not show the PREVIOUS attempt's trailing live text.
      if (type === WORKFLOW_NODE_STARTED) {
        setLiveOutputByNodeId((current) => {
          if (!current.has(nodeId)) return current;
          const next = new Map(current);
          next.delete(nodeId);
          return next;
        });
      }
    }

    if (RESNAPSHOT_ON.has(type)) onResnapshotRef.current?.();
  }, []);

  const stream = useEventStream({
    path,
    scope,
    eventNames: RUN_STREAM_EVENT_NAMES,
    onEvent,
    enabled,
  });

  return { status: stream.status, events, nodeStatusById, liveOutputByNodeId, reopen: stream.reopen };
}
