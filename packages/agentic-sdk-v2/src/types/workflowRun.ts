/**
 * @arcaai/vox — workflow INVOCATION types (TASK-850 lane B).
 *
 * Transcribed from the artifacts the gateway actually ships, not from prose:
 * the DTOs in `packages/applications/src/services/workflow-exposure/dto/`, and
 * the SSE envelope + `type` literals in
 * `apps/api/src/modules/workflows/workflow-run-event.ts` and
 * `apps/harness/src/harness/temporal/interpreter/run_events.py`.
 *
 * These stay structurally identical to `@arcaai/vox-node`'s `types/workflow.ts`
 * — one gateway contract, two runtimes — but are declared here rather than
 * imported: the browser SDK must not depend on the server SDK, and the server
 * SDK ships zero runtime dependencies.
 */

/** One entry of the workflow catalogue (either plane). */
export interface WorkflowSummary {
  /** The public URL segment — what you pass as `slug` to start a run. */
  slug: string;
  name: string;
  description: string | null;
  /** `summarization` on the unbound plane; also `consultation` on the consultation-bound plane. */
  paletteKey: string;
  /** The ACTIVE published version currently resolved for this slug. */
  versionNumber: number;
}

/** The `202 Accepted` handle to a run that is now executing durably. */
export interface WorkflowRunHandle {
  runId: string;
  /**
   * `started` for a fresh run; `already_running` when an `Idempotency-Key`
   * collision JOINED the run already in flight rather than starting a second.
   */
  status: 'started' | 'already_running';
  /** Gateway-relative path for the status read. */
  statusUrl: string;
  /** Gateway-relative path for the SSE stream. */
  streamUrl: string;
}

/**
 * Terminal statuses the interpreter reports. Byte-identical to the gateway's
 * own `TERMINAL_STATUSES` — a second spelling is a UI that spins forever on a
 * run the server already considers finished.
 */
export const TERMINAL_RUN_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'] as const);

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/** `true` when `status` is one the run will never move away from. */
export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Live run status — also the `mode=blocking` 200 body. */
export interface WorkflowRunStatus {
  runId: string;
  slug: string;
  workflowVersionNumber: number;
  /** `RUNNING` | `COMPLETED` | `FAILED` | `CANCELED` | `TIMED_OUT` | … */
  status: string;
  /** Per-stage detail; interpreter-owned shape, deliberately not narrowed. */
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
  /**
   * What the run DELIVERED: `{ resultRef: {...} }` (claim-check pointer) or
   * `{ outputs: {...} }` inline. `null` while in flight, and for any graph with
   * no `output.deliver` node.
   */
  resultRef: Record<string, unknown> | null;
}

/** Every `event:` type a run stream can carry. */
export type WorkflowRunEventType =
  | 'workflow.run.progress'
  | 'workflow.run.completed'
  | 'workflow.node.started'
  | 'workflow.node.completed'
  | 'workflow.node.failed'
  | 'workflow.loop.iteration'
  | 'workflow.guardrail.verdict'
  | 'workflow.token.delta';

/** Payload of a snapshot (`workflow.run.progress` / `.completed`) frame. */
export interface WorkflowRunEventPayload {
  runId: string;
  slug: string;
  workflowVersionNumber: number;
  status: string;
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
  [extra: string]: unknown;
}

/**
 * One decoded stream frame — the async-contract envelope plus the frame's own
 * opaque `resumeToken`.
 *
 * `resumeToken` is the SSE `id:` line: present on every pushed frame, ABSENT on
 * the snapshot frame (a snapshot is not a stream position). Never parse it.
 */
export interface WorkflowRunEvent<TPayload = WorkflowRunEventPayload> {
  schemaVersion: number;
  /** The envelope's own identity (UUIDv7) — NOT a resume cursor. */
  id: string;
  tenantId: string;
  type: WorkflowRunEventType | string;
  occurredAt: string;
  /** Always the `runId`: every event about one run shares it. */
  correlationId: string;
  causationId: string | null;
  /** Intent-derived, never random — two deliveries of one fact carry one key. */
  idempotencyKey: string;
  payload?: TPayload;
  /** The frame's opaque resume cursor. Absent on a snapshot frame. */
  resumeToken?: string;
}
