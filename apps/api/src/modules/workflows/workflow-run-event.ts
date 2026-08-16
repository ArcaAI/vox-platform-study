import { randomUUID } from 'node:crypto';
import { ASYNC_ENVELOPE_SCHEMA_VERSION, AsyncEnvelope } from '@arcaai/async-contract';
import { WorkflowRunStatusResponse } from '@arcaai/applications';

/** Terminal statuses the interpreter reports — mirrors `WorkflowExposureService`'s own set. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

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
 * Build the async-contract envelope (TASK-717 S-5) for one polled snapshot of
 * a run's live status (TASK-722 Task 8).
 *
 * No upstream event PRODUCER exists on the interpreter yet (no
 * `text/event-stream` endpoint, no Redis-stream-backed progress channel —
 * verified against `apps/harness/src/harness/api/endpoints/interpreter.py`,
 * which exposes only `POST …:start` / `GET …/{runId}` / `POST …:cancel`, all
 * plain JSON). This gateway BRIDGES from repeated polls of that JSON status
 * read into the envelope shape S-5 requires, rather than proxying a live
 * stream byte-for-byte (there is nothing to proxy). `type` is
 * `workflow.run.progress` while the run is live and `workflow.run.completed`
 * on the FIRST terminal snapshot — after which the caller stops polling.
 *
 * `idempotencyKey` is `wf:run:<runId>:status:<status>` — a pure function of
 * (run, discrete status), so repeated ticks reporting the SAME status
 * reproduce the SAME key (the async-contract idempotency rule: derived from
 * intent, never chance). This is NOT the `AsyncIdempotencyKey.workflowNode`
 * per-node recipe the design doc's recipe table names for a genuine
 * interpreter-emitted event — there is no such source envelope to forward
 * (the design doc's own note for this ticket: "reuse the source envelope's
 * idempotencyKey unchanged" assumes one exists; here, this gateway IS the
 * producer, synthesizing its own poll-tick events).
 *
 * `correlationId` is the `runId` (every event caused by/about the same run
 * shares it); `causationId` is always `null` — a poll tick is not CAUSED by a
 * prior envelope, it is an independent observation.
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

/** One SSE wire frame: `event: <type>\nid: <envelope.id>\ndata: <json>\n\n`. `id` is the
 *  envelope's own identity, NOT a resume cursor — see the class doc on `WorkflowStreamService`
 *  for why no resume token is minted (async-contract §3.6: never synthesize one for a
 *  non-resumable transport). */
export function formatSseFrame(envelope: AsyncEnvelope<WorkflowRunEventPayload>): string {
  return `event: ${envelope.type}\nid: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
