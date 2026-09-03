import { randomUUID } from 'node:crypto';
import { ASYNC_ENVELOPE_SCHEMA_VERSION, AsyncEnvelope } from '@arcaai/async-contract';
import { WorkflowRunStatusResponse } from '@arcaai/applications';

/** Terminal statuses the interpreter reports — mirrors `WorkflowExposureService`'s own set. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/**
 * The Redis Stream key carrying one run's produced events.
 *
 * MUST stay byte-identical to the producer's own `run_event_stream_key()`
 * (`apps/harness/src/harness/temporal/interpreter/run_events.py`). Two spellings
 * of one key is a stream that silently carries nothing —
 * `workflow-stream.service.test.ts` pins the exact literal for that reason.
 */
export function runEventStreamKey(runId: string): string {
  return `wf:run:${runId}:events`;
}

/**
 * The transport name embedded in a resume token (async-contract Also
 * matches the producer's `RUN_EVENT_TRANSPORT`. A token minted by a different
 * transport is rejected rather than fed to `XREAD` as a cursor.
 */
export const RUN_EVENT_TRANSPORT = 'redis-stream';

/** The producer's terminal event type — the PUSH that lets a client close its stream instead
 *  of inferring the end from a status that stopped changing. */
export const WORKFLOW_RUN_COMPLETED = 'workflow.run.completed';

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** One `payload` shape carried by a `workflow.run.progress` / `workflow.run.completed` envelope. */
export interface WorkflowRunEventPayload {
  runId: string;
  slug: string;
  workflowVersionNumber: number;
  status: string;
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Build the async-contract envelope for a SNAPSHOT of a run's
 * live status.
 *
 * **This is no longer a poll tick.** It was, until lane A built the
 * producer: there was no `text/event-stream` endpoint and no
 * Redis-stream-backed progress channel on the interpreter dispatcher, so this
 * gateway synthesized an event per poll. It now emits this shape EXACTLY TWICE
 * per connection at most — once on connect, and once more if a trimmed-id gap
 * forces a resync (`WorkflowStreamService`, client-contract steps 1 and 4).
 * Every other frame is a real producer envelope, forwarded unchanged.
 *
 * The SHAPE is kept byte-compatible with the polling version on purpose: an
 * existing client that only understands `workflow.run.progress` /
 * `workflow.run.completed` keeps working across this change.
 *
 * `idempotencyKey` is `wf:run:<runId>:status:<status>` — a pure function of
 * (run, discrete status), so two snapshots reporting the SAME status reproduce
 * the SAME key (the async-contract rule: derived from intent, never chance),
 * which is what lets a client collapse the reconnect resync against the
 * snapshot it already has. It is NOT the `AsyncIdempotencyKey.workflowNode`
 * per-node recipe — that belongs to the producer's own node events, which this
 * gateway forwards rather than mints.
 *
 * `correlationId` is the `runId` (every event caused by/about the same run
 * shares it); `causationId` is always `null` — an observation of current state
 * is not CAUSED by a prior envelope.
 */
export function buildWorkflowRunEventEnvelope(tenantId: string, status: WorkflowRunStatusResponse): AsyncEnvelope<WorkflowRunEventPayload> {
  return {
    schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId,
    type: isTerminalRunStatus(status.status) ? 'workflow.run.completed' : 'workflow.run.progress',
    occurredAt: new Date().toISOString(),
    correlationId: status.runId,
    causationId: null,
    idempotencyKey: `wf:run:${status.runId}:status:${status.status}`,
    payload: {
      runId: status.runId,
      slug: status.slug,
      workflowVersionNumber: status.workflowVersionNumber,
      status: status.status,
      stages: status.stages,
      startedAt: status.startedAt,
      endedAt: status.endedAt,
    },
  };
}

/**
 * One SSE wire frame.
 *
 * `resumeToken` is the OPAQUE, transport-assigned cursor (async-contract — the value the
 * browser echoes back as `Last-Event-ID` and never parses. It is present on every frame read
 * from the run's Redis Stream, where Redis assigns the message id, and ABSENT on the snapshot
 * frame, where there is no stream position to name.
 *
 * That absence is a rule, not an omission: forbids synthesizing a token a transport cannot
 * actually resume from. Emitting the envelope's own `id` there would look like a cursor and
 * resume nothing — which is exactly the failure the opaque-token convention exists to prevent
 * (this file's previous version did emit `envelope.id`, back when there was no producer and
 * therefore no cursor to have).
 */
export function formatSseFrame(envelope: AsyncEnvelope<unknown>, resumeToken?: string): string {
  const idLine = resumeToken === undefined ? '' : `id: ${resumeToken}\n`;
  return `event: ${envelope.type}\n${idLine}data: ${JSON.stringify(envelope)}\n\n`;
}
