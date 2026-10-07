/**
 * The wire body of `POST internal/guardrail/evaluations` (TASK-1050 W1; README §9.8.2): a record of EVERY
 * guardrail evaluation, clean ones included — one record per request x direction, the checks as an array.
 *
 * Producer: apps/guardrail appends each record to a Redis-stream outbox BEFORE it answers; a drainer posts
 * batches of at most {@link GUARDRAIL_EVALUATION_BATCH_MAX}. Consumer: the gateway (service token,
 * `X-Tenant-Id` mandatory and equal to every record's `tenantId`), idempotent on `evaluationId`, so a redriven
 * batch is safe (at-least-once). The verdict never waits on the write.
 *
 * No judged text and no judge reasoning anywhere. `withheldContent` is the ONLY content field: present only on
 * an OUTBOUND BLOCK (README §9.7.6), plaintext on this internal wire, encrypted (Transit) by the gateway before
 * it is stored, and readable only through the admin review route.
 *
 * Frozen by `tests/contracts/guardrail-evaluation.fixture.json`.
 */
import type {
  GuardrailActionTaken,
  GuardrailCaller,
  GuardrailCheckId,
  GuardrailCheckVerdict,
  GuardrailDecision,
  GuardrailDirection,
} from './guardrail-vocabulary.js';
import type { GuardrailNotice } from './guardrail-notice.js';

/** Route (under the global `api/v1` prefix). */
export const GUARDRAIL_EVALUATIONS_PATH = 'internal/guardrail/evaluations';

/** Records per POST. A larger outbox drains in several batches. */
export const GUARDRAIL_EVALUATION_BATCH_MAX = 100;

/**
 * A named exemption that skipped a check, recorded rather than invisible. `medical_internal` = the wire
 * exemption `medical_exempt: "internal"` (TASK-1035 OD-5), which the gateway strips from business bodies.
 */
export const GUARDRAIL_EVALUATION_EXEMPTIONS = ['medical_internal'] as const;
export type GuardrailEvaluationExemption = (typeof GUARDRAIL_EVALUATION_EXEMPTIONS)[number];

/** A context item at the version that was screened (a violation belongs to a version, README §9.7.4). */
export interface GuardrailEvaluationItemRef {
  readonly itemId: string;
  readonly itemVersion: number;
}

export interface GuardrailEvaluationCheck {
  readonly checkId: GuardrailCheckId;
  readonly verdict: GuardrailCheckVerdict;
  /** Classifier score in [0,1], higher = more unsafe (TASK-1049 contract), when the check has one. */
  readonly score?: number;
  /** The lane's verdict category, on a flag. */
  readonly category?: string;
  /** Judge confidence in [0,1], when a judge answered. */
  readonly confidence?: number;
  readonly actionTaken: GuardrailActionTaken;
  /** The model slug that answered; `null` when the check did not run (`skipped`). */
  readonly model: string | null;
  /** 0 for a check that did not run. */
  readonly latencyMs: number;
  /** The screened regions (`transcript:w1`, `response`, …). Empty when the check did not run. */
  readonly regionKeys: readonly string[];
  /** The context items behind those regions, at the screened version. */
  readonly items: readonly GuardrailEvaluationItemRef[];
}

export interface GuardrailEvaluationRecord {
  /** uuidv7; becomes the `GuardrailEvaluation.id`. The idempotency key. */
  readonly evaluationId: string;
  readonly tenantId: string;
  /** TASK-1015 `X-Request-Id`. */
  readonly requestId: string;
  // Correlation (forwarded as `GUARDRAIL_CORRELATION_HEADERS`).
  readonly consultationId?: string;
  readonly runId?: string;
  /** Joins `AiActivityRun`. */
  readonly runKey?: string;
  readonly nodeId?: string;
  readonly itemId?: string;
  readonly agentSlug?: string;
  readonly caller: GuardrailCaller;
  readonly direction: GuardrailDirection;
  readonly decision: GuardrailDecision;
  readonly exempt?: GuardrailEvaluationExemption;
  readonly checks: readonly GuardrailEvaluationCheck[];
  readonly policyVersion: string;
  /** The `GuardrailNotice`s this evaluation raised (empty for allow / ignore). */
  readonly noticeIds: readonly string[];
  /**
   * The full notices behind `noticeIds`, so the gateway (the only writer) can persist them
   * (`GuardrailNoticeRepository.upsertByDedupeKey`). Omitted when `noticeIds` is empty.
   * Orchestrator amendment, TASK-1050 2026-10-07.
   */
  readonly notices?: readonly GuardrailNotice[];
  /** Outbound block only. PLAINTEXT on the wire; the gateway encrypts before storing. */
  readonly withheldContent?: string;
  /** ISO-8601 UTC, when guardrail decided (stored as the row's `at`). */
  readonly occurredAt: string;
}

export interface GuardrailEvaluationBatchRequest {
  /** 1..{@link GUARDRAIL_EVALUATION_BATCH_MAX} records. */
  readonly evaluations: readonly GuardrailEvaluationRecord[];
}

/** 200: how many records were new and how many were already stored (a redrive). */
export interface GuardrailEvaluationBatchResponse {
  readonly accepted: number;
  readonly duplicates: number;
}
