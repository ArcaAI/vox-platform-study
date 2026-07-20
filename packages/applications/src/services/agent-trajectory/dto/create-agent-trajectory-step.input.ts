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
}
