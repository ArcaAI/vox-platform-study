import { AgentSessionKind, AgentStepStatus, AgentStepType, JsonValue } from '@arcaai/domains';

/**
 * the ingest shape for one ordered trajectory step.
 *
 * This is an INTERNAL ingest input (emitters call `recordSteps`), not an HTTP
 * request DTO — so it is a plain interface (no class-validator whitelist). The
 * apps/api wave maps its internal-route body onto this shape.
 *
 * `runId` is a NON-NULL empty-string sentinel (`""`) for non-Temporal sessions
 * (LIVE_DOC / SUMMARY_JOB / EVAL_RUN): the composite unique
 * `(tenantId, sessionId, runId, seq)` idempotency depends on runId never being
 * null. When omitted the service defaults it to `""` (via the factory).
 */
export interface CreateAgentTrajectoryStepInput {
  tenantId: string;
  consultationId?: string | null;
  sessionKind: AgentSessionKind;
  /** Live session id | Temporal workflowId | job id | eval run id. */
  sessionId: string;
  /** Temporal runId when applicable; `""` sentinel otherwise (default). */
  runId?: string;
  /** Per-`(sessionId, runId)` monotonic sequence, emitter-assigned. */
  seq: number;
  stepType: AgentStepType;
  /** e.g. "flush", "nlp.classify-tokens", "groundedness", "publish". */
  name: string;
  status: AgentStepStatus;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  /** AD-1 GenerationStats on LLM_CALL steps; null otherwise. */
  stats?: JsonValue | null;
  /** Claim-check ref / encrypted pointer — never plaintext clinical content. */
  payloadRef?: JsonValue | null;
  errorCode?: string | null;
  correlationId?: string | null;
  // ── TASK-957 F-8: attribution, NOT persisted state ─────────────────────────
  // None of the four has a column on `AgentTrajectoryStep`, and none is meant
  // to: they exist to reach the usage-ledger emission that rides this same
  // ingest. Carried on the input rather than on the entity so the trajectory
  // table does not grow four columns nothing reads back.
  /** The clinician the run acts for — the interpreter's `RunSubject.userId`. */
  doctorId?: string | null;
  /** The interpreter node this step belongs to. */
  nodeId?: string | null;
  /** The published workflow-definition version that node belongs to. */
  workflowVersionId?: string | null;
  /**
   * The node's TYPE (`core.agent`, …).
   *
   * Accepted from the wire and deliberately not stamped on a ledger row:
   * `attributesJson` is a PHI allow-list whose extension is a deliberate act,
   * `nodeId` already identifies the node within its version, and the type is
   * recoverable from the definition. It is carried so a worker that sends it is
   * never 400'd by the whitelist, and so the ingest shape matches the wire.
   */
  nodeType?: string | null;
}
