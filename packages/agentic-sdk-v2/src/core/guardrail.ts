/**
 * @arcaai/vox — guardrail errors, notices and hold helpers (TASK-1050).
 *
 * A guardrail BLOCK reaches a client in three shapes, one notice schema (`GuardrailNotice` v1, `@arcaai/types`):
 * a 422 problem (`urn:hope:problem:guardrail-blocked`) on a synchronous call, a `guardrail.notice` event on a run
 * stream, and a consultation HOLD (`processingReason` `GUARDRAIL_HOLD`). This module is the pure half:
 *
 * - {@link GuardrailBlockedError} / {@link GuardrailHoldError} / {@link EgressRedactionUnavailableError} — typed
 *   `AgenticError`s the client throws for the 422 / 503, so existing `catch (e) { if (e instanceof AgenticError) … }`
 *   code keeps working and the legacy `CONTENT_BLOCKED*` identifier stays on `error.context.code`.
 * - {@link mergeGuardrailNotices} — the dedupe-by-`noticeId` the `guardrailNotices` state slices use.
 *
 * No React, no I/O. Notices carry no content and no judge reasoning: show `defaultMessage` (or localise on `messageKey`).
 */

import type { GuardrailNotice } from '@arcaai/types';
import { AgenticError, type AgenticErrorCode } from '../types/common';

export type { GuardrailNotice } from '@arcaai/types';

/** RFC 9457 `type` of a guardrail block (`@arcaai/types` `GUARDRAIL_BLOCKED_PROBLEM_TYPE`). */
export const GUARDRAIL_BLOCKED_PROBLEM_TYPE = 'urn:hope:problem:guardrail-blocked';

/** The `code` of the retryable 503 raised when the cloud-egress pseudonymiser is down. */
export const EGRESS_REDACTION_UNAVAILABLE_CODE = 'EGRESS_REDACTION_UNAVAILABLE';

/** The `processingReason`s of a resumable guardrail hold (mirror of `@arcaai/types` `GUARDRAIL_HOLD_PROCESSING_REASONS`). */
export const GUARDRAIL_HOLD_PROCESSING_REASONS = ['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE'] as const;

/** `true` when `reason` is a guardrail hold: the consultation waits for a resume (or an approve with `resolveHold`). */
export function isGuardrailHoldReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && (GUARDRAIL_HOLD_PROCESSING_REASONS as readonly string[]).includes(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NOTICE_TYPES: readonly string[] = ['guardrail.warning', 'guardrail.blocked', 'guardrail.unverified'];

/** A notice we can render by `noticeId`, `type` and `messageKey`. Lenient about fields a newer server adds. */
export function isGuardrailNotice(value: unknown): value is GuardrailNotice {
  return (
    isRecord(value) &&
    typeof value.noticeId === 'string' &&
    value.noticeId !== '' &&
    typeof value.type === 'string' &&
    NOTICE_TYPES.includes(value.type) &&
    typeof value.messageKey === 'string'
  );
}

/**
 * Merge `incoming` into `current`, one notice per `noticeId`, in first-seen order. A repeat REPLACES the earlier entry
 * (its `requiresAcknowledgement` / `resumable` may have moved). Returns `current` itself when nothing changed, so a
 * React state setter bails out of a re-render.
 */
export function mergeGuardrailNotices(current: readonly GuardrailNotice[], incoming: readonly GuardrailNotice[]): readonly GuardrailNotice[] {
  let next: GuardrailNotice[] | undefined;
  for (const notice of incoming) {
    if (!isGuardrailNotice(notice)) continue;
    const list = next ?? [...current];
    const index = list.findIndex((existing) => existing.noticeId === notice.noticeId);
    if (index === -1) {
      list.push(notice);
      next = list;
    } else if (JSON.stringify(list[index]) !== JSON.stringify(notice)) {
      list[index] = notice;
      next = list;
    }
  }
  return next ?? current;
}

interface GuardrailErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
  notice?: GuardrailNotice;
  evaluationIds?: readonly string[];
}

/**
 * The 422 of a guardrail BLOCK. A decision, not a fault: show {@link notice} and, when `notice.resumable`, offer the
 * resume path (`useConsultation().resumeHold`). `error.context.code` keeps the legacy `CONTENT_BLOCKED*` identifier.
 */
export class GuardrailBlockedError extends AgenticError {
  readonly notice: GuardrailNotice | undefined;
  readonly evaluationIds: readonly string[];

  constructor(code: AgenticErrorCode, message: string, options: GuardrailErrorOptions = {}) {
    super(code, message, { cause: options.cause, context: options.context });
    this.name = 'GuardrailBlockedError';
    this.notice = options.notice;
    this.evaluationIds = options.evaluationIds ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A retryable 503 from a guardrail hold. {@link retryable} is always `true`. */
export class GuardrailHoldError extends AgenticError {
  readonly retryable = true as const;
  readonly notice: GuardrailNotice | undefined;
  readonly evaluationIds: readonly string[];

  constructor(code: AgenticErrorCode, message: string, options: GuardrailErrorOptions = {}) {
    super(code, message, { cause: options.cause, context: options.context });
    this.name = 'GuardrailHoldError';
    this.notice = options.notice;
    this.evaluationIds = options.evaluationIds ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 503 `EGRESS_REDACTION_UNAVAILABLE`: patient details could not be pseudonymised, so NOTHING was sent to the external model. Retry once it is back. */
export class EgressRedactionUnavailableError extends GuardrailHoldError {
  constructor(code: AgenticErrorCode, message: string, options: GuardrailErrorOptions = {}) {
    super(code, message, options);
    this.name = 'EgressRedactionUnavailableError';
  }
}

function noticeOfBody(body: unknown): GuardrailNotice | undefined {
  if (!isRecord(body)) return undefined;
  const candidate = body.guardrailNotice ?? (isRecord(body.metadata) ? body.metadata.guardrailNotice : undefined);
  return isGuardrailNotice(candidate) ? candidate : undefined;
}

function evaluationIdsOfBody(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const ids = body.guardrailEvaluationIds ?? (isRecord(body.metadata) ? body.metadata.guardrailEvaluationIds : undefined);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Build the error for a non-2xx response: a typed guardrail error for the 422 block / the retryable 503, else a plain
 * {@link AgenticError}. `context` gains `guardrailNotice` / `guardrailEvaluationIds`, and the legacy `error_code` is
 * lifted to `context.code` when the body carried no `code`.
 */
export function buildHttpError(
  status: number,
  code: AgenticErrorCode,
  message: string,
  context: Record<string, unknown>,
  body: unknown,
): AgenticError {
  const notice = noticeOfBody(body);
  const evaluationIds = evaluationIdsOfBody(body);
  const legacyCode = isRecord(body) && typeof body.error_code === 'string' ? body.error_code : undefined;
  const type = isRecord(body) && typeof body.type === 'string' ? body.type : undefined;
  const bodyCode = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;

  const isBlock = status === 422 && (type === GUARDRAIL_BLOCKED_PROBLEM_TYPE || notice !== undefined);
  const isEgress = status === 503 && (bodyCode === EGRESS_REDACTION_UNAVAILABLE_CODE || notice?.messageKey === 'guardrail.blocked.redaction_unavailable');
  const isHold = status === 503 && notice !== undefined;
  if (!isBlock && !isEgress && !isHold) return new AgenticError(code, message, { context });

  const enriched: Record<string, unknown> = { ...context };
  if (notice !== undefined) enriched.guardrailNotice = notice;
  if (evaluationIds.length > 0) enriched.guardrailEvaluationIds = evaluationIds;
  if (enriched.code === undefined && legacyCode !== undefined) enriched.code = legacyCode;
  if (enriched.code === undefined && isEgress) enriched.code = EGRESS_REDACTION_UNAVAILABLE_CODE;
  const text = notice !== undefined && /^HTTP \d{3}/.test(message) ? notice.defaultMessage : message;
  const options: GuardrailErrorOptions = { context: enriched, notice, evaluationIds };
  if (isBlock) return new GuardrailBlockedError(code, text, options);
  if (isEgress) return new EgressRedactionUnavailableError(code, text, options);
  return new GuardrailHoldError(code, text, options);
}
