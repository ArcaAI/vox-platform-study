/**
 * Guardrail wire vocabulary (TASK-1050 W1; README §9.2, §9.7, §9.8, §11.1) — the words every service, both
 * SDKs and the console use for a guardrail check and its outcome. Pure const arrays and types.
 *
 * Frozen by `tests/contracts/guardrail-vocabulary.fixture.json`; the check ids are additionally pinned
 * against `apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json`, which the Python
 * plane (`core/availability.py`) and the gateway catalogue (`policy-catalogue.ts`) read too.
 *
 * Every wire value is lowercase. Prisma enums (W0) may spell members in SCREAMING_CASE; the mapping is
 * listed in the vocabulary fixture's `prismaMappingTodo` and reconciled by the orchestrator:
 *
 * TODO(TASK-1050 merge): reconcile with W0's Prisma enum names —
 *   GuardrailItemStatus CLEAN|WARNED|BLOCKED|WITHHELD  <->  clean|warned|blocked|withheld
 *   GuardrailDecision   ALLOW|WARN|BLOCK|UNVERIFIED    <->  allow|warn|block|unverified
 *   GuardrailDirection  INBOUND|OUTBOUND               <->  inbound|outbound
 *   caller (if an enum) TEXT_GENERATE|TEXT_TRANSLATE|HARNESS_GUARDRAIL_CHECK|PLAYGROUND|GOVERNED_PROMPT
 *   acknowledgement via (if an enum) ACK|APPROVE|RESUME; HoldResolution (if an enum) ITEM_EXCLUDED|ITEM_EDITED|ACKNOWLEDGED
 */

/**
 * Every guardrail check a tenant policy can name: the eight TASK-886 classifier checks, the locked medical
 * judge, and the four TASK-1050 safety judges — in catalogue (contract) order.
 */
export const GUARDRAIL_CHECK_IDS = [
  'jailbreak_detection',
  'prompt_safety',
  'prompt_toxicity',
  'response_safety',
  'response_toxicity',
  'response_refusal',
  'pii_leak',
  'containment_echo',
  'medical_validation',
  'injection_judge',
  'unsafe_content_judge',
  'clinical_safety_judge',
  'leakage_judge',
] as const;
export type GuardrailCheckId = (typeof GUARDRAIL_CHECK_IDS)[number];

/** The four LLM safety-judge lanes (README §3.1); each has one criteria prompt under the §11.3 C template. */
export const GUARDRAIL_JUDGE_CHECK_IDS = ['injection_judge', 'unsafe_content_judge', 'clinical_safety_judge', 'leakage_judge'] as const;
export type GuardrailJudgeCheckId = (typeof GUARDRAIL_JUDGE_CHECK_IDS)[number];

export function isGuardrailCheckId(value: unknown): value is GuardrailCheckId {
  return typeof value === 'string' && (GUARDRAIL_CHECK_IDS as readonly string[]).includes(value);
}

/** `inbound` screens what goes INTO a model (request, transcript, notes); `outbound` screens what comes out. */
export const GUARDRAIL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type GuardrailDirection = (typeof GUARDRAIL_DIRECTIONS)[number];

/**
 * What a VIOLATION of a check does (README §9.2): `ignore` records it and the user sees nothing; `warn`
 * continues and raises a `guardrail.warning` notice; `block` stops the operation (a resumable hold inside
 * a consultation, README §9.8.1). Set by the platform admin only (§11.1).
 */
export const GUARDRAIL_ACTIONS = ['ignore', 'warn', 'block'] as const;
export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

/**
 * The decision for one request in one direction. Precedence block > warn > unverified > allow.
 * `unverified`: no violation, but at least one check could not run (outage) and degraded (README §9.8.1).
 */
export const GUARDRAIL_DECISIONS = ['allow', 'warn', 'block', 'unverified'] as const;
export type GuardrailDecision = (typeof GUARDRAIL_DECISIONS)[number];

/** What one check found — independent of the action configured for it. Mirrors `screening.py` OUTCOME_*. */
export const GUARDRAIL_CHECK_VERDICTS = ['pass', 'flag', 'undetermined', 'skipped'] as const;
export type GuardrailCheckVerdict = (typeof GUARDRAIL_CHECK_VERDICTS)[number];

/**
 * What the platform actually did with one check's verdict: `none` for a `pass` / `skipped`; the configured
 * action for a `flag`; `unverified` for an `undetermined` that degraded (or `ignore` under an ignore action).
 */
export const GUARDRAIL_ACTIONS_TAKEN = ['none', 'ignore', 'warn', 'block', 'unverified'] as const;
export type GuardrailActionTaken = (typeof GUARDRAIL_ACTIONS_TAKEN)[number];

/** The denormalised marker on a consultation context item (`ContextItem.guardrailStatus`, README §9.7.4). */
export const GUARDRAIL_ITEM_STATUSES = ['clean', 'warned', 'blocked', 'withheld'] as const;
export type GuardrailItemStatus = (typeof GUARDRAIL_ITEM_STATUSES)[number];

/** Inbound region trust (TASK-1047 FC-5b): an `instruction` region decides; a `data` region is clinical content. */
export const GUARDRAIL_REGION_TRUSTS = ['instruction', 'data'] as const;
export type GuardrailRegionTrust = (typeof GUARDRAIL_REGION_TRUSTS)[number];

/** Who asked guardrail (`GuardrailEvaluation.caller`, README §9.8.2). */
export const GUARDRAIL_CALLERS = ['text.generate', 'text.translate', 'harness.guardrail_check', 'playground', 'governed_prompt'] as const;
export type GuardrailCaller = (typeof GUARDRAIL_CALLERS)[number];

/**
 * Optional correlation headers a caller forwards to guardrail beside the mandatory `X-Tenant-Id` and the
 * TASK-1015 `X-Request-Id` (README §9.6 "Correlation"). Each lands on the `GuardrailEvaluation` record.
 * HTTP header names are case-insensitive; these are the canonical spellings.
 */
export const GUARDRAIL_CORRELATION_HEADERS = Object.freeze({
  consultationId: 'X-Hope-Consultation-Id',
  runId: 'X-Hope-Run-Id',
  itemId: 'X-Hope-Item-Id',
  runKey: 'X-Hope-Run-Key',
  nodeId: 'X-Hope-Node-Id',
} as const);
export type GuardrailCorrelationField = keyof typeof GUARDRAIL_CORRELATION_HEADERS;

/**
 * Re-run of a node after an `acknowledged` hold resolution (TASK-1050 §9.8.1, harness W2f).
 * Value: the resolved `noticeId`. INTERNAL ONLY — the gateway strips every `X-Hope-*`
 * header from business-plane requests, and guardrail honours it only after verifying (read-only)
 * that the notice is RESOLVED with resolution `acknowledged` for the same tenant and that the
 * check's platform floor is below `block`.
 */
export const GUARDRAIL_OVERRIDE_HEADER = 'X-Hope-Guardrail-Override' as const;
/** Every `X-Hope-*` header name is internal; external requests carrying one are stripped. */
export const HOPE_INTERNAL_HEADER_PREFIX = 'x-hope-' as const;

/** Fixed machine codes the gateway answers with (README §11.1, §9.7.7). */
export const GUARDRAIL_ERROR_CODES = Object.freeze({
  /** 403: a tenant admin's write touched a field only a platform admin may set (field-level split gate). */
  fieldPlatformOnly: 'GUARDRAIL_FIELD_PLATFORM_ONLY',
  /** 409: the consultation is in a guardrail hold and the request did not resolve it. */
  hold: 'GUARDRAIL_HOLD',
  /** 400: a lane → model routing write names a model whose `_metadata.judge` does not declare the lane (§12). */
  judgeLaneUnsupported: 'JUDGE_LANE_UNSUPPORTED',
} as const);
