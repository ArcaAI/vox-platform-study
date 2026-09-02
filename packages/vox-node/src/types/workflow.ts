/**
 * Types for the WORKFLOW INVOCATION plane (TASK-850 lane B).
 *
 * Every shape here is transcribed from the gateway artifacts that actually
 * ship it, not from the ticket prose:
 *
 * - `WorkflowSummary` / `WorkflowRunHandle` / `WorkflowRunStatus` mirror
 *   `packages/applications/src/services/workflow-exposure/dto/*.ts`.
 * - `WorkflowRunEvent` mirrors `@arcaai/async-contract`'s `AsyncEnvelope`
 *   plus the concrete `type` literals produced by
 *   `apps/harness/src/harness/temporal/interpreter/run_events.py` and
 *   `apps/api/src/modules/workflows/workflow-run-event.ts`.
 *
 * The envelope is re-declared structurally rather than imported from
 * `@arcaai/async-contract`: this package ships ZERO runtime dependencies, and
 * a workspace `dependencies` entry is a runtime dependency however
 * type-shaped its use looks at the call site.
 */

/** One entry of `GET /api/v1/workflows` and `GET /api/v1/consultations/:id/workflows`. */
export interface WorkflowSummary {
  /** The public URL segment — the value you pass as `slug` to every run method. */
  slug: string;
  name: string;
  description: string | null;
  /** `summarization` on the unbound plane; also `consultation` on the consultation-bound plane. */
  paletteKey: string;
  /** The ACTIVE published version currently resolved for this slug. */
  versionNumber: number;
}

/** `202 Accepted` body — the handle to a run that is now executing durably. */
export interface WorkflowRunHandle {
  runId: string;
  /**
   * `started` for a fresh run; `already_running` when an `Idempotency-Key`
   * (or workflow-id) collision JOINED the run that was already going, rather
   * than starting — and billing — a second one.
   */
  status: 'started' | 'already_running';
  /** Gateway-relative path for `getRun`. */
  statusUrl: string;
  /** Gateway-relative path for `streamRun`. */
  streamUrl: string;
}

/**
 * Terminal statuses the interpreter reports. Byte-identical to
 * `TERMINAL_STATUSES` in `apps/api/src/modules/workflows/workflow-run-event.ts`
 * — a second spelling here would mean an SDK that waits forever for a run the
 * gateway already considers finished.
 */
export const TERMINAL_RUN_STATUSES: readonly string[] = Object.freeze(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** `true` when `status` is one the interpreter will never move away from. */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Live run status — `GET /api/v1/workflows/:slug/runs/:runId`, and the `mode=blocking` 200 body. */
export interface WorkflowRunStatus {
  runId: string;
  slug: string;
  workflowVersionNumber: number;
  /** Live, Temporal-sourced: `RUNNING` | `COMPLETED` | `FAILED` | `CANCELED` | `TIMED_OUT` | … */
  status: string;
  /** Per-stage detail; the shape is interpreter-owned and deliberately not narrowed here. */
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
  /**
   * What the run DELIVERED. Either `{ resultRef: { bucket, key, sizeBytes } }`
   * — a claim-check pointer to fetch out of band — or `{ outputs: {...} }`
   * inline for a small payload. `null` while in flight, and for any graph with
   * no `output.deliver` node.
   */
  resultRef: Record<string, unknown> | null;
}

/** Response of `POST /api/v1/workflows/:slug/runs/:runId/cancel`. */
export interface WorkflowRunCancelResult {
  runId: string;
  /** `cancel_requested` — the signal was sent; cancellation is not necessarily complete yet. */
  status: string;
}

/**
 * Every `event:` type a workflow run stream can carry.
 *
 * `workflow.run.progress` is minted by the GATEWAY as the snapshot frame (at
 * most twice per connection: on connect, and again if a trimmed-id gap forces
 * a resync). Every other literal is PUSHED by the interpreter's producer.
 */
export type WorkflowRunEventType =
  | 'workflow.run.progress'
  | 'workflow.run.completed'
  | 'workflow.node.started'
  | 'workflow.node.completed'
  | 'workflow.node.failed'
  | 'workflow.loop.iteration'
  | 'workflow.guardrail.verdict'
  | 'workflow.token.delta';

/** Claim-check reference carried by an envelope too large to inline. */
export interface WorkflowClaimCheckRef {
  bucket: string;
  key: string;
  sizeBytes?: number;
  [extra: string]: unknown;
}

/**
 * One decoded stream frame: the async-contract envelope, plus the frame's own
 * opaque `resumeToken`.
 *
 * `resumeToken` is the SSE `id:` line. It is present on every pushed frame and
 * ABSENT on a snapshot frame — a snapshot is not a stream position, and
 * async-contract §3.6 forbids minting a token the transport cannot resume
 * from. Never parse it; echo it back as `Last-Event-ID`, which
 * {@link WorkflowsResource.streamRun} does for you.
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
  /** Intent-derived, never random — two deliveries of one fact carry one key, so duplicates collapse. */
  idempotencyKey: string;
  payload?: TPayload;
  payloadRef?: WorkflowClaimCheckRef;
  /** The frame's opaque resume cursor. Absent on a snapshot frame. */
  resumeToken?: string;
}

/** Payload of a `workflow.run.progress` / `workflow.run.completed` snapshot frame. */
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

/** Body of every run-start call. `input` is opaque and forwarded verbatim to the interpreter. */
export interface StartWorkflowRunRequest {
  input: Record<string, unknown>;
}
