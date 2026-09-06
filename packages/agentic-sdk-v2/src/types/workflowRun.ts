/**
 * @arcaai/vox — workflow INVOCATION types.
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
  /**
   * JSON Schema of the run `input` (TASK-890), from the definition's Trigger. `null` when the
   * definition declares none — deliberately NOT an open `object` schema, because "we do not
   * know" and "anything goes" are different facts and a form built from the second when the
   * first is true renders fields the run will refuse.
   */
  inputSchema: Record<string, unknown> | null;
  /** JSON Schema of what the run delivers, from the definition's Output. `null` when undeclared. */
  outputSchema: Record<string, unknown> | null;
  /** Output protocols the definition publishes (`http`, `http-sse`, `socket`). `[]` for a legacy graph (unrestricted). */
  protocols: string[];
  /** Trigger kinds the definition accepts (`api`, `webhook`, …). `[]` for a legacy graph, treated as `api`. */
  triggerKinds: string[];
}

/**
 * `GET /workflows/:slug/schema` — the generated contract of one published definition.
 *
 * Everything {@link WorkflowSummary} carries, plus the machine-readable projections a portal
 * or a form generator wants: OpenAPI `components.schemas` entries and an AsyncAPI 3 fragment
 * for the run event stream. The catalogue already answers the four facts above, so reach for
 * this when you want the PROJECTIONS, not to decide what to send.
 */
export interface WorkflowSchemaDescription {
  slug: string;
  versionNumber: number;
  triggerKinds: string[];
  protocols: string[];
  /**
   * The delivery lanes this definition admits: the `?mode=` values the run route accepts
   * (`async` | `blocking` | `stream`), plus `socket` when the Output publishes it — a LANE,
   * not a `?mode=` value.
   */
  modes: string[];
  components: Record<string, Record<string, unknown>>;
  asyncapi: Record<string, unknown>;
}

/**
 * Live state of ONE `core.humanReview` node of a run (TASK-890).
 *
 * `exists: false` is a NORMAL answer — the node has not been reached, or the review already
 * settled and its durable child is gone. It is NOT the same as a failed read, which the hook
 * reports as `null` + an `error`. Collapsing the two renders "nothing to approve" during an
 * outage, which is how queued clinical work goes missing.
 */
export interface WorkflowReview {
  runId: string;
  /** The graph node id of the review node — a graph may carry several, each addressed separately. */
  nodeId: string;
  exists: boolean;
  /** `WAITING` | `ESCALATED` | `DECIDED` | `TIMED_OUT`; `null` when no child exists. */
  phase: string | null;
  escalations: number | null;
  decided: boolean;
  /** `null` until a human decides. **A timeout never becomes `approved`.** */
  decision: 'approved' | 'rejected' | null;
}

/**
 * The decision to send. There is deliberately no `reviewerId`: the gateway stamps the acting
 * user from your session, and its DTO forbids undeclared properties, so sending one is a 400.
 */
export interface WorkflowReviewDecision {
  decision: 'approved' | 'rejected';
  comment?: string;
  /** Honoured only when the review node was authored with `allowEdit`; the workflow drops it otherwise. */
  editedPayload?: Record<string, unknown>;
}

/** Response of the decide call — the signal was SENT; the graph resumes on its own clock. */
export interface WorkflowReviewDecisionResult {
  runId: string;
  nodeId: string;
  decision: 'approved' | 'rejected';
  signaled: boolean;
  /** The acting user the gateway resolved from your session. */
  reviewerId: string | null;
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
