/**
 * TASK-1050 W3b — a failed call, read as a guardrail outcome (README §9.7.3, §9.8.1).
 *
 * Three shapes reach the console:
 *
 * | Shape | Where it comes from |
 * |---|---|
 * | `GatewayError` (BFF proxy) | the gateway envelope with TEXT's problem members at the TOP level (W2b relay): `code` (legacy `CONTENT_BLOCKED*`), `type` `urn:hope:problem:guardrail-blocked`, a validated `guardrailNotice`, `guardrailEvaluationIds`; the egress 503 adds `processingReason` + `retryable` |
 * | an SDK typed error (`@arcaai/vox`) | `GuardrailBlockedError` / `GuardrailHoldError` / `EgressRedactionUnavailableError` with `notice` + `context.code` — recognised by NAME, so a stale SDK build (no such class) never breaks an `instanceof` |
 * | an older gateway | only `error_code` `CONTENT_BLOCKED*` in the body |
 *
 * The notice is re-validated ({@link toGuardrailNotice}); a notice that fails is dropped, never rendered.
 */
import { GatewayError } from '@/shared/api';
import { toGuardrailNotice, type GuardrailNotice } from './notice';

export const GUARDRAIL_BLOCKED_PROBLEM_TYPE = 'urn:hope:problem:guardrail-blocked';
export const EGRESS_REDACTION_UNAVAILABLE_CODE = 'EGRESS_REDACTION_UNAVAILABLE';
export const GUARDRAIL_HOLD_CODE = 'GUARDRAIL_HOLD';

export type GuardrailErrorOutcome =
  /** The guardrail stopped this generation (422). `code` keeps the legacy `CONTENT_BLOCKED*` identifier. */
  | { kind: 'blocked'; code: string | null; notice: GuardrailNotice | null; evaluationIds: string[] }
  /** Cloud-egress pseudonymisation was down, nothing was sent (503, retryable). A privacy hold, not a verdict. */
  | { kind: 'redaction_unavailable'; code: string; notice: GuardrailNotice | null; evaluationIds: string[] }
  /** The consultation is in a guardrail hold (409 `GUARDRAIL_HOLD`, or a 503 hold carrying a notice). */
  | { kind: 'hold'; code: string | null; notice: GuardrailNotice | null; evaluationIds: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

function fromBody(status: number, body: Record<string, unknown>): GuardrailErrorOutcome | null {
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const notice = toGuardrailNotice(body.guardrailNotice ?? metadata.guardrailNotice);
  const evaluationIds = idsOf(body.guardrailEvaluationIds ?? metadata.guardrailEvaluationIds);
  const code = stringOf(body.code) ?? stringOf(body.error_code) ?? stringOf(metadata.code);
  const legacyCode = stringOf(body.error_code);
  // The envelope fills `code` with `HTTP.*` when the body had none; prefer the legacy identifier then.
  const effectiveCode = code && code.startsWith('HTTP.') ? (legacyCode ?? code) : code;

  if (
    effectiveCode === EGRESS_REDACTION_UNAVAILABLE_CODE ||
    body.processingReason === EGRESS_REDACTION_UNAVAILABLE_CODE ||
    notice?.messageKey === 'guardrail.blocked.redaction_unavailable'
  ) {
    return { kind: 'redaction_unavailable', code: EGRESS_REDACTION_UNAVAILABLE_CODE, notice, evaluationIds };
  }
  if (status === 409 && effectiveCode === GUARDRAIL_HOLD_CODE) return { kind: 'hold', code: effectiveCode, notice, evaluationIds };
  const isBlockCode = typeof effectiveCode === 'string' && effectiveCode.startsWith('CONTENT_BLOCKED');
  if (status === 422 && (body.type === GUARDRAIL_BLOCKED_PROBLEM_TYPE || notice !== null || isBlockCode)) {
    return { kind: 'blocked', code: effectiveCode, notice, evaluationIds };
  }
  if (status === 503 && notice !== null) return { kind: 'hold', code: effectiveCode, notice, evaluationIds };
  return null;
}

/** The guardrail outcome behind `error`, or `null` when it is not one. */
export function classifyGuardrailError(error: unknown): GuardrailErrorOutcome | null {
  if (error instanceof GatewayError) {
    return isRecord(error.details) ? fromBody(error.status, error.details) : null;
  }
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const candidate = error as unknown as { name?: unknown; notice?: unknown; evaluationIds?: unknown; context?: unknown };
  const context = isRecord(candidate.context) ? candidate.context : {};
  const notice = toGuardrailNotice(candidate.notice ?? context.guardrailNotice);
  const evaluationIds = idsOf(candidate.evaluationIds ?? context.guardrailEvaluationIds);
  const code = stringOf(context.code);
  switch (candidate.name) {
    case 'GuardrailBlockedError':
      return { kind: 'blocked', code, notice, evaluationIds };
    case 'EgressRedactionUnavailableError':
      return { kind: 'redaction_unavailable', code: EGRESS_REDACTION_UNAVAILABLE_CODE, notice, evaluationIds };
    case 'GuardrailHoldError':
      return { kind: 'hold', code, notice, evaluationIds };
    default:
      return null;
  }
}
