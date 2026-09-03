import { randomUUID } from 'node:crypto';
import { ASYNC_ENVELOPE_SCHEMA_VERSION, AsyncEnvelope } from '@arcaai/async-contract';
import { SandboxRunStatusResponse } from '@arcaai/applications';

/**
 * Mirrors `../workflows/workflow-run-event.ts`'s terminal-status set exactly, for
 *  the same reason: the interpreter's status vocabulary is a single source of truth this
 *  gateway does not own. Kept as a local copy (not imported) — `workflows/` and
 *  `workflow-sandbox-run/` are sibling, independently-owned gateway modules; see the class doc
 *  on `WorkflowSandboxStreamService` for why this bridge exists at all.
 */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

export function isTerminalSandboxRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** One `payload` shape carried by a `workflow.sandbox_run.progress` / `.completed` envelope. */
export interface WorkflowSandboxRunEventPayload {
  runId: string;
  workflowDefinitionId: string;
  status: string;
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Build the async-contract envelope (reused per precedent) for one
 * polled snapshot of a Workbench sandbox run's live status.
 *
 * Same bridge posture as `../workflows/workflow-run-event.ts`: the interpreter dispatcher has
 * no push event producer (`apps/harness/.../interpreter.py` exposes only plain-JSON
 * start/status/cancel), so this gateway polls and re-packages each snapshot into the envelope
 * shape rather than proxying a live stream byte-for-byte.
 */
export function buildWorkflowSandboxRunEventEnvelope(
  tenantId: string,
  status: SandboxRunStatusResponse,
): AsyncEnvelope<WorkflowSandboxRunEventPayload> {
  return {
    schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
    id: randomUUID(),
    tenantId,
    type: isTerminalSandboxRunStatus(status.status) ? 'workflow.sandbox_run.completed' : 'workflow.sandbox_run.progress',
    occurredAt: new Date().toISOString(),
    correlationId: status.runId,
    causationId: null,
    idempotencyKey: `wf:sandbox-run:${status.runId}:status:${status.status}`,
    payload: {
      runId: status.runId,
      workflowDefinitionId: status.workflowDefinitionId,
      status: status.status,
      stages: status.stages,
      startedAt: status.startedAt,
      endedAt: status.endedAt,
    },
  };
}

/**
 * One SSE wire frame — same shape as `../workflows/workflow-run-event.ts`'s `formatSseFrame`.
 * `id` is the envelope's own identity, NOT a resume cursor (async-contract: never
 *  synthesize a resume token for this non-resumable poll-bridge transport).
 */
export function formatSandboxRunSseFrame(envelope: AsyncEnvelope<WorkflowSandboxRunEventPayload>): string {
  return `event: ${envelope.type}\nid: ${envelope.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
