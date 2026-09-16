/**
 * Types for the WORKFLOW INVOCATION plane.
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
  /**
   * JSON Schema of the run `input` (TASK-890), from the definition's Trigger.
   *
   * `null` for a definition that declares none — a legacy palette, or a `core` graph whose
   * Trigger carries no inline context schema. That is deliberately NOT an open `object`
   * schema: "we do not know" and "anything goes" are different facts, and generating a client
   * from the second when the first is true produces code that compiles and then 400s.
   */
  inputSchema: Record<string, unknown> | null;
  /** JSON Schema of what the run delivers, from the definition's Output. `null` when undeclared. */
  outputSchema: Record<string, unknown> | null;
  /**
   * Output protocols the definition publishes. `http` admits `runAndWait`, `http-sse` admits
   * `runAndStream` / `streamRun`; `[]` (a legacy graph) is unrestricted.
   */
  protocols: string[];
  /** Trigger kinds the definition accepts (`api`, `webhook`, …). `[]` for a legacy graph, treated as `api`. */
  triggerKinds: string[];
}

/**
 * `GET /api/v1/workflows/{slug}/schema` — the generated contract for one published definition.
 *
 * Everything {@link WorkflowSummary} carries, plus the machine-readable projections a portal
 * or a code generator wants: OpenAPI `components.schemas` entries and an AsyncAPI 3 fragment
 * for the run event stream.
 *
 * Why this is not in the committed `openapi.json`: a workflow's schema is TENANT data, and
 * that artifact is emitted offline with no database. The static document describes the generic
 * route family; this describes YOUR definition.
 */
export interface WorkflowSchemaDescription {
  slug: string;
  versionNumber: number;
  triggerKinds: string[];
  protocols: string[];
  /**
   * The delivery lanes this definition admits: the `?mode=` values the run route accepts
   * (`async` | `blocking` | `stream`), plus `socket` when the Output publishes it. `socket` is
   * a LANE, not a `?mode=` value — the AsyncAPI fragment describes it.
   */
  modes: string[];
  /** OpenAPI 3.1 `components.schemas` entries, keyed `Workflow_<slug>_Input` / `_Output`. */
  components: Record<string, Record<string, unknown>>;
  /** An AsyncAPI 3 fragment for the SSE / WebSocket frames of a run. */
  asyncapi: Record<string, unknown>;
  /**
   * The consultation context schema this definition's `core.trigger` is bound to, when it is
   * bound to one at all (`null` for a definition with no consultation trigger). `followsLatest`
   * tells you whether `versionNumber` tracks the tenant's current pin (`true`) or is frozen to
   * the version the workflow was published against (`false`, D-1).
   */
  contextSchema: { schemaId: string; slug: string; versionNumber: number; followsLatest: boolean } | null;
  /**
   * Every `core.humanReview` node in the graph, in graph order — how a caller discovers the
   * `nodeId` to pass {@link WorkflowsResource.reviews.get} / `.decide` without hardcoding it.
   */
  reviewNodes: Array<{ nodeId: string; label: string }>;
}

/**
 * Live state of ONE `core.humanReview` node of a run —
 * `GET /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}`.
 *
 * `exists: false` is a NORMAL answer: the node has not been reached yet, or the review already
 * settled and its durable child is gone. It is not an error and not a 404 — a 404 means the
 * RUN is not yours. Keep the two apart in your UI, or "someone else's run" will render as
 * "nothing to approve".
 */
export interface WorkflowReview {
  runId: string;
  /** The graph node id of the review node — a graph may carry several, each addressed separately. */
  nodeId: string;
  exists: boolean;
  /** `WAITING` | `ESCALATED` | `DECIDED` | `TIMED_OUT`; `null` when no child exists. */
  phase: string | null;
  /** How many times the wait has escalated; `null` when no child exists. */
  escalations: number | null;
  decided: boolean;
  /**
   * `null` until a human decides. **A timeout never becomes `approved`** — the durable
   * workflow has no default and no fallback, and neither does this field.
   */
  decision: 'approved' | 'rejected' | null;
}

/**
 * Body of `POST …/reviews/{nodeId}/decide`.
 *
 * There is deliberately no `reviewerId`: the gateway stamps the acting user from your session,
 * and its request DTO forbids undeclared properties, so sending one is a 400. That is what
 * stops a caller signing somebody else's name to an approval.
 */
export interface WorkflowReviewDecision {
  decision: 'approved' | 'rejected';
  /** Free-text rationale recorded with the decision. */
  comment?: string;
  /**
   * A corrected payload to hand back to the graph in place of what was reviewed. Honoured only
   * when the node was authored with `allowEdit`; the workflow drops it otherwise.
   */
  editedPayload?: Record<string, unknown>;
}

/** Response of `POST …/reviews/{nodeId}/decide` — the signal was SENT; the graph resumes on its own clock. */
export interface WorkflowReviewDecisionResult {
  runId: string;
  nodeId: string;
  decision: 'approved' | 'rejected';
  signaled: boolean;
  /** The acting user the gateway resolved from your session. */
  reviewerId: string | null;
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
  /**
   * `true` when the run finished with at least one degraded or skipped-for-cause node.
   * DEGRADED is a per-run FLAG, never a persisted run STATUS (D-9 — `status` above never carries
   * the interpreter's own `DEGRADED` word); read this instead of trying to infer degradation from
   * `status`.
   */
  degraded: boolean;
  /** Total nodes the run scheduled. `null` until the run's completion event has been recorded. */
  nodeCount: number | null;
  /** Nodes that ended FAILED. `null` until the run's completion event has been recorded. */
  failedNodeCount: number | null;
  /** Nodes that ended DEGRADED. `null` until the run's completion event has been recorded. */
  degradedNodeCount: number | null;
  /** Nodes SKIPPED for cause. `null` until the run's completion event has been recorded. */
  skippedNodeCount: number | null;
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
 * async-contract forbids minting a token the transport cannot resume
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
