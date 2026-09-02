'use client';

/**
 * TASK-849 lane C — the run-trace screen's PUSH transport. Replaces the 5 s
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
import type { WorkflowNodeEventPayload, WorkflowRunEventEnvelope } from './types';

export const WORKFLOW_RUN_PROGRESS = 'workflow.run.progress';
export const WORKFLOW_RUN_COMPLETED = 'workflow.run.completed';
export const WORKFLOW_NODE_STARTED = 'workflow.node.started';
export const WORKFLOW_NODE_COMPLETED = 'workflow.node.completed';
export const WORKFLOW_NODE_FAILED = 'workflow.node.failed';
export const WORKFLOW_LOOP_ITERATION = 'workflow.loop.iteration';
export const WORKFLOW_GUARDRAIL_VERDICT = 'workflow.guardrail.verdict';

/** Every type name this hook subscribes to — kept as one list so the `eventNames`
 *  passed to `useEventStream` and the switch below can never drift apart. */
const RUN_STREAM_EVENT_NAMES = [
  WORKFLOW_RUN_PROGRESS,
  WORKFLOW_RUN_COMPLETED,
  WORKFLOW_NODE_STARTED,
  WORKFLOW_NODE_COMPLETED,
  WORKFLOW_NODE_FAILED,
  WORKFLOW_LOOP_ITERATION,
  WORKFLOW_GUARDRAIL_VERDICT,
] as const;

/** Frames whose arrival means the durable trace has moved and is worth re-fetching. */
const RESNAPSHOT_ON = new Set<string>([WORKFLOW_RUN_PROGRESS, WORKFLOW_RUN_COMPLETED, WORKFLOW_NODE_COMPLETED, WORKFLOW_NODE_FAILED]);

/** Append-only log cap — mirrors `JobStreamPanel`'s `MAX_EVENTS` (frame 35 precedent). */
const MAX_EVENTS = 200;

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
  reopen: () => void;
}

function parseEnvelope(data: string): WorkflowRunEventEnvelope<WorkflowNodeEventPayload> | null {
  try {
    return JSON.parse(data) as WorkflowRunEventEnvelope<WorkflowNodeEventPayload>;
  } catch {
    return null;
  }
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

  const onResnapshotRef = useRef(onResnapshot);
  useEffect(() => {
    onResnapshotRef.current = onResnapshot;
  }, [onResnapshot]);

  // A remount (new runId) must not carry the previous run's log/status map forward.
  useEffect(() => {
    setEvents([]);
    setNodeStatusById(new Map());
  }, [runId]);

  const path = runId && slug ? workflowRunStreamPath(slug, runId) : null;
  const scope = runId ? workflowRunStreamScope(runId) : null;

  const onEvent = useCallback((type: string, data: string) => {
    const envelope = parseEnvelope(data);
    if (!envelope) return;
    const payload = envelope.payload ?? {};

    setEvents((current) => [...current.slice(-(MAX_EVENTS - 1)), { type, occurredAt: envelope.occurredAt, payload }]);

    if (payload.nodeId && (type === WORKFLOW_NODE_STARTED || type === WORKFLOW_NODE_COMPLETED || type === WORKFLOW_NODE_FAILED)) {
      const nodeId = payload.nodeId;
      setNodeStatusById((current) => {
        const next = new Map(current);
        next.set(nodeId, payload);
        return next;
      });
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

  return { status: stream.status, events, nodeStatusById, reopen: stream.reopen };
}
