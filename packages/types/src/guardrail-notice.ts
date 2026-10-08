/**
 * `GuardrailNotice` v1 — the ONE standard message a client receives when a guardrail check warns, blocks or
 * could not run (TASK-1050 W1; README §9.7.3, §9.8.1). One schema, three transports:
 *
 * | Transport | warn / unverified | block |
 * |---|---|---|
 * | Synchronous HTTP (generate, summary job result) | 200 with `guardrailNotices` ({@link GuardrailResponseAdditions}) | 422 {@link GuardrailBlockedProblem} |
 * | Workflow run stream (run protocol v2) | public event `guardrail.notice` | `guardrail.notice`, then `run.paused` (hold) or `run.failed GUARDRAIL_BLOCKED` |
 * | Consultation lifecycle SSE | — | state only (`processingReason: GUARDRAIL_HOLD`); the client reads the notice by id |
 *
 * PHI rules (load-bearing): a notice carries NO content and NO judge reasoning — either can quote PHI or the
 * injection itself. `defaultMessage` is EXACTLY the fixed label of `messageKey`
 * ({@link GUARDRAIL_NOTICE_DEFAULT_MESSAGES}); the run protocol refuses any other text. Clients localise on
 * `messageKey`. Dedup is one notice per `(consultation or request, direction, type, target, policyVersion)`; `checks`
 * lists every check that raised it (TASK-1050 follow-up E).
 *
 * Frozen by `tests/contracts/guardrail-vocabulary.fixture.json` (vocabulary) and
 * `tests/contracts/guardrail-run-events.fixture.json` (example notices). Mirrored in
 * `packages/async-contract/src/run-protocol.ts` (the `guardrail.notice` schema) and in harness Python (W2f).
 */
import type { GuardrailCheckId, GuardrailDirection } from './guardrail-vocabulary.js';

export const GUARDRAIL_NOTICE_SCHEMA_VERSION = 1;

/**
 * `guardrail.warning`: a `warn` violation, the operation continued. `guardrail.blocked`: a `block` violation,
 * the operation stopped (resumable inside a consultation). `guardrail.unverified`: a check could not run and
 * degraded (README §9.8.1) — warn weight, never a stop.
 */
export const GUARDRAIL_NOTICE_TYPES = ['guardrail.warning', 'guardrail.blocked', 'guardrail.unverified'] as const;
export type GuardrailNoticeType = (typeof GUARDRAIL_NOTICE_TYPES)[number];

/** A notice is only ever raised for these two actions (`ignore` raises nothing). */
export const GUARDRAIL_NOTICE_ACTIONS = ['warn', 'block'] as const;
export type GuardrailNoticeAction = (typeof GUARDRAIL_NOTICE_ACTIONS)[number];

/** The ONE action each notice type carries (a cross-field rule the run protocol enforces). */
export const GUARDRAIL_NOTICE_TYPE_ACTION: Readonly<Record<GuardrailNoticeType, GuardrailNoticeAction>> = Object.freeze({
  'guardrail.warning': 'warn',
  'guardrail.blocked': 'block',
  'guardrail.unverified': 'warn',
});

/** UI weight, machine-readable (README §9.7.3) — never prose. */
export const GUARDRAIL_NOTICE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type GuardrailNoticeSeverity = (typeof GUARDRAIL_NOTICE_SEVERITIES)[number];

/**
 * Stable localisation keys. Each starts with `<notice type>.`. `guardrail.blocked.not_medical` is the locked
 * medical-validation block; `guardrail.blocked.redaction_unavailable` is the cloud-egress pseudonymiser being
 * down (processing reason `EGRESS_REDACTION_UNAVAILABLE`, a privacy hold, not a safety verdict — its `checks`
 * is empty).
 */
export const GUARDRAIL_NOTICE_MESSAGE_KEYS = [
  'guardrail.warning.generic',
  'guardrail.blocked.inbound',
  'guardrail.blocked.outbound',
  'guardrail.blocked.not_medical',
  'guardrail.blocked.redaction_unavailable',
  'guardrail.unverified.generic',
] as const;
export type GuardrailNoticeMessageKey = (typeof GUARDRAIL_NOTICE_MESSAGE_KEYS)[number];

/** The fixed English label of each key — generic, never quoting content. A contract change, never a per-call string. */
export const GUARDRAIL_NOTICE_DEFAULT_MESSAGES: Readonly<Record<GuardrailNoticeMessageKey, string>> = Object.freeze({
  'guardrail.warning.generic': 'A safety check flagged this content. Review it before you rely on it.',
  'guardrail.blocked.inbound': 'A safety check stopped this request. Review the flagged input to continue.',
  'guardrail.blocked.outbound': 'A safety check withheld the generated content. Review it to continue.',
  'guardrail.blocked.not_medical':
    'This content is outside clinical documentation, so it was not processed. Review the flagged input to continue.',
  'guardrail.blocked.redaction_unavailable':
    'Patient details could not be protected before sending to an external model, so processing is paused. Retry to continue.',
  'guardrail.unverified.generic': 'A safety check could not run, so this content was not verified. Review it before you rely on it.',
});

/** The one `defaultMessage` a notice with this key may carry. */
export function guardrailNoticeDefaultMessage(key: GuardrailNoticeMessageKey): string {
  return GUARDRAIL_NOTICE_DEFAULT_MESSAGES[key];
}

export interface GuardrailNoticeCheck {
  readonly checkId: GuardrailCheckId;
  /** The lane's verdict category (e.g. `credential`); absent for an `unverified` check, which found nothing. */
  readonly category?: string;
  readonly severity: GuardrailNoticeSeverity;
}

export interface GuardrailNotice {
  readonly schemaVersion: typeof GUARDRAIL_NOTICE_SCHEMA_VERSION;
  /** uuidv7. Referenced by `GuardrailEvaluation.noticeIds`, `run.paused`, acknowledgement and resume. */
  readonly noticeId: string;
  readonly type: GuardrailNoticeType;
  readonly direction: GuardrailDirection;
  /** Always `GUARDRAIL_NOTICE_TYPE_ACTION[type]`. */
  readonly action: GuardrailNoticeAction;
  /** May be empty only for `guardrail.blocked.redaction_unavailable`. */
  readonly checks: readonly GuardrailNoticeCheck[];
  readonly consultationId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  /** The context items the notice marks (inbound: the source items; outbound: the generated item). */
  readonly itemIds: readonly string[];
  readonly messageKey: GuardrailNoticeMessageKey;
  /** Exactly `GUARDRAIL_NOTICE_DEFAULT_MESSAGES[messageKey]`. */
  readonly defaultMessage: string;
  /** The clinician must acknowledge it (an explicit ack, or atomically on approve — README §9.8.3). */
  readonly requiresAcknowledgement: boolean;
  /** A hold the client may resume (`POST consultations/:id/guardrail-hold/resume`). */
  readonly resumable: boolean;
  /** The guardrail policy version the verdict was decided under — replayable audit. */
  readonly policyVersion: string;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
}

/** Added to a successful synchronous response (TEXT `/generate` JSON body, a summary job result). */
export interface GuardrailResponseAdditions {
  readonly guardrailNotices: readonly GuardrailNotice[];
  /** One per request x direction; the reconciler's gap-detection key (README §9.8.2). */
  readonly guardrailEvaluationIds: readonly string[];
}

/**
 * RFC 9457 `type` of a guardrail block. A URN, so no hostname is frozen into the contract. NOTE: the gateway's
 * own error envelope (`apps/api/src/filters/error-envelope.ts`) deliberately is NOT RFC 9457; how the gateway
 * relays this body is lane W2b/W2c's call (the notice and the evaluation ids must survive the relay).
 */
export const GUARDRAIL_BLOCKED_PROBLEM_TYPE = 'urn:hope:problem:guardrail-blocked';

/** TEXT's 422 body for a block: problem details + the legacy `error_code` (`CONTENT_BLOCKED*`) for old clients. */
export interface GuardrailBlockedProblem {
  readonly type: typeof GUARDRAIL_BLOCKED_PROBLEM_TYPE;
  readonly title: string;
  readonly status: 422;
  /** The existing `CONTENT_BLOCKED*` code, kept for clients that predate the notice. */
  readonly error_code: string;
  readonly guardrailNotice: GuardrailNotice;
  readonly guardrailEvaluationIds: readonly string[];
}
