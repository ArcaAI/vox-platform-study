/** TASK-1050 W2d — typed guardrail errors from the client, and the notice dedupe the state slices use. */

import { describe, expect, it } from 'vitest';
import { AgenticError } from '../../types/common';
import {
  EGRESS_REDACTION_UNAVAILABLE_CODE,
  EgressRedactionUnavailableError,
  GUARDRAIL_BLOCKED_PROBLEM_TYPE,
  GuardrailBlockedError,
  GuardrailHoldError,
  buildHttpError,
  isGuardrailHoldReason,
  mergeGuardrailNotices,
} from '../guardrail';
import type { GuardrailNotice } from '../guardrail';

const notice = (id: string, over: Record<string, unknown> = {}): GuardrailNotice =>
  ({
    schemaVersion: 1,
    noticeId: id,
    type: 'guardrail.blocked',
    direction: 'outbound',
    action: 'block',
    checks: [{ checkId: 'leakage_judge', severity: 'high' }],
    itemIds: ['i1'],
    messageKey: 'guardrail.blocked.outbound',
    defaultMessage: 'A safety check withheld the generated content. Review it to continue.',
    requiresAcknowledgement: true,
    resumable: true,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...over,
  }) as GuardrailNotice;

describe('buildHttpError', () => {
  it('maps the 422 problem to GuardrailBlockedError, keeping the AgenticError bucket and the legacy code', () => {
    const error = buildHttpError(
      422,
      'VALIDATION_ERROR',
      'HTTP 422: Unprocessable Entity',
      { status: 422, endpoint: '/x' },
      { type: GUARDRAIL_BLOCKED_PROBLEM_TYPE, error_code: 'CONTENT_BLOCKED_OUTPUT', guardrailNotice: notice('n1'), guardrailEvaluationIds: ['e1'] },
    );
    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error).toBeInstanceOf(AgenticError);
    const blocked = error as GuardrailBlockedError;
    expect(blocked.code).toBe('VALIDATION_ERROR');
    expect(blocked.context?.code).toBe('CONTENT_BLOCKED_OUTPUT');
    expect(blocked.notice?.noticeId).toBe('n1');
    expect(blocked.evaluationIds).toEqual(['e1']);
    expect(blocked.message).toBe(notice('n1').defaultMessage);
  });

  it('keeps a server message and a body `code` as the context code', () => {
    const error = buildHttpError(422, 'VALIDATION_ERROR', 'Blocked.', { status: 422, code: 'CONTENT_BLOCKED' }, { guardrailNotice: notice('n1'), code: 'CONTENT_BLOCKED' });
    expect(error.message).toBe('Blocked.');
    expect(error.context?.code).toBe('CONTENT_BLOCKED');
  });

  it('maps the 503 egress code to a retryable EgressRedactionUnavailableError', () => {
    const error = buildHttpError(503, 'API_ERROR', 'down', { status: 503, retryAfter: '3' }, { code: EGRESS_REDACTION_UNAVAILABLE_CODE });
    expect(error).toBeInstanceOf(EgressRedactionUnavailableError);
    expect(error).toBeInstanceOf(GuardrailHoldError);
    expect((error as GuardrailHoldError).retryable).toBe(true);
    expect(error.context?.retryAfter).toBe('3');
    expect(error.context?.code).toBe(EGRESS_REDACTION_UNAVAILABLE_CODE);
  });

  it('a 503 with another notice is a GuardrailHoldError; unrelated errors stay plain AgenticErrors', () => {
    expect(buildHttpError(503, 'API_ERROR', 'x', {}, { guardrailNotice: notice('n2') })).toBeInstanceOf(GuardrailHoldError);
    for (const [status, body] of [
      [422, { code: 'OTHER' }],
      [503, { code: 'UPSTREAM' }],
      [400, { guardrailNotice: notice('n3') }],
    ] as const) {
      const error = buildHttpError(status, 'API_ERROR', 'x', { status }, body);
      expect(error).toBeInstanceOf(AgenticError);
      expect(error).not.toBeInstanceOf(GuardrailBlockedError);
      expect(error).not.toBeInstanceOf(GuardrailHoldError);
    }
  });
});

describe('mergeGuardrailNotices', () => {
  it('deduplicates by noticeId, keeping first-seen order', () => {
    const a = notice('a');
    const b = notice('b');
    const merged = mergeGuardrailNotices([a], [b, a, b]);
    expect(merged.map((n) => n.noticeId)).toEqual(['a', 'b']);
  });

  it('returns the same array when nothing changed (no re-render) and replaces a changed repeat', () => {
    const a = notice('a');
    const current = [a];
    expect(mergeGuardrailNotices(current, [notice('a')])).toBe(current);
    const updated = mergeGuardrailNotices(current, [notice('a', { requiresAcknowledgement: false })]);
    expect(updated).not.toBe(current);
    expect(updated[0]?.requiresAcknowledgement).toBe(false);
  });

  it('drops values that are not notices', () => {
    const current: GuardrailNotice[] = [];
    expect(mergeGuardrailNotices(current, [{ nope: 1 } as never])).toBe(current);
  });
});

describe('isGuardrailHoldReason', () => {
  it('names the two hold reasons only', () => {
    expect(isGuardrailHoldReason('GUARDRAIL_HOLD')).toBe(true);
    expect(isGuardrailHoldReason('EGRESS_REDACTION_UNAVAILABLE')).toBe(true);
    expect(isGuardrailHoldReason('NOTE_READY')).toBe(false);
    expect(isGuardrailHoldReason(null)).toBe(false);
  });
});
