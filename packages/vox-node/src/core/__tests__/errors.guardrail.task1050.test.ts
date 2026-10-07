/** TASK-1050 W2d — `fromResponse` maps the guardrail 422 and 503 to typed errors and keeps the legacy codes working. */

import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  EgressRedactionUnavailableError,
  GUARDRAIL_BLOCKED_PROBLEM_TYPE,
  GuardrailBlockedError,
  GuardrailHoldError,
  HopeAPIError,
  QuotaExceededError,
  fromResponse,
} from '../errors';

const NOTICE = {
  schemaVersion: 1,
  noticeId: '01927f6e-9999-7000-8000-0000000000ab',
  type: 'guardrail.blocked',
  direction: 'outbound',
  action: 'block',
  checks: [{ checkId: 'leakage_judge', category: 'credential', severity: 'high' }],
  itemIds: ['i1'],
  messageKey: 'guardrail.blocked.outbound',
  defaultMessage: 'A safety check withheld the generated content. Review it to continue.',
  requiresAcknowledgement: true,
  resumable: true,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-07T09:15:00.000Z',
};
const REDACTION_NOTICE = {
  ...NOTICE,
  noticeId: 'n-red',
  direction: 'inbound',
  checks: [],
  messageKey: 'guardrail.blocked.redaction_unavailable',
  defaultMessage: 'Patient details could not be protected before sending to an external model, so processing is paused. Retry to continue.',
};

const res = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers });

describe('fromResponse — guardrail block (422)', () => {
  const body = {
    type: GUARDRAIL_BLOCKED_PROBLEM_TYPE,
    title: 'A guardrail blocked the content.',
    status: 422,
    error_code: 'CONTENT_BLOCKED_OUTPUT',
    guardrailNotice: NOTICE,
    guardrailEvaluationIds: ['ev-1', 'ev-2'],
  };

  it('is a GuardrailBlockedError carrying the notice, the evaluation ids and the legacy code', () => {
    const error = fromResponse(res(422), body);
    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error).toBeInstanceOf(HopeAPIError);
    const blocked = error as GuardrailBlockedError;
    expect(blocked.status).toBe(422);
    expect(blocked.notice?.noticeId).toBe(NOTICE.noticeId);
    expect(blocked.notice?.resumable).toBe(true);
    expect(blocked.evaluationIds).toEqual(['ev-1', 'ev-2']);
    expect(blocked.code).toBe('CONTENT_BLOCKED_OUTPUT');
  });

  it('an old body without error_code still maps and defaults the code', () => {
    const error = fromResponse(res(422), { type: GUARDRAIL_BLOCKED_PROBLEM_TYPE, guardrailNotice: NOTICE }) as GuardrailBlockedError;
    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error.code).toBe('GUARDRAIL_BLOCKED');
    expect(error.evaluationIds).toEqual([]);
  });

  it('a body relayed with `code` (the gateway envelope) keeps it', () => {
    const error = fromResponse(res(422), { code: 'CONTENT_BLOCKED', guardrailNotice: NOTICE }) as GuardrailBlockedError;
    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error.code).toBe('CONTENT_BLOCKED');
  });

  it('finds the notice under metadata too', () => {
    const error = fromResponse(res(422), { type: GUARDRAIL_BLOCKED_PROBLEM_TYPE, metadata: { guardrailNotice: NOTICE, guardrailEvaluationIds: ['e'] } }) as GuardrailBlockedError;
    expect(error.notice?.noticeId).toBe(NOTICE.noticeId);
    expect(error.evaluationIds).toEqual(['e']);
  });

  it('an unrelated 422 stays a plain HopeAPIError', () => {
    const error = fromResponse(res(422), { code: 'SOMETHING_ELSE', message: 'nope' });
    expect(error).not.toBeInstanceOf(GuardrailBlockedError);
    expect(error).toBeInstanceOf(HopeAPIError);
    expect(error.code).toBe('SOMETHING_ELSE');
  });
});

describe('fromResponse — egress redaction unavailable (503, retryable)', () => {
  it('maps the code to a retryable EgressRedactionUnavailableError with Retry-After', () => {
    const error = fromResponse(res(503, { 'retry-after': '3' }), { code: 'EGRESS_REDACTION_UNAVAILABLE', guardrailNotice: REDACTION_NOTICE });
    expect(error).toBeInstanceOf(EgressRedactionUnavailableError);
    expect(error).toBeInstanceOf(GuardrailHoldError);
    const hold = error as EgressRedactionUnavailableError;
    expect(hold.retryable).toBe(true);
    expect(hold.status).toBe(503);
    expect(hold.retryAfterMs).toBe(3000);
    expect(hold.notice?.messageKey).toBe('guardrail.blocked.redaction_unavailable');
  });

  it('recognises it from the notice alone', () => {
    expect(fromResponse(res(503), { guardrailNotice: REDACTION_NOTICE })).toBeInstanceOf(EgressRedactionUnavailableError);
  });

  it('a 503 carrying another notice is a generic GuardrailHoldError; one without is untouched', () => {
    expect(fromResponse(res(503), { guardrailNotice: NOTICE })).toBeInstanceOf(GuardrailHoldError);
    expect(fromResponse(res(503), { code: 'UPSTREAM' })).not.toBeInstanceOf(GuardrailHoldError);
  });
});

describe('fromResponse — existing mappings are unchanged', () => {
  it('400 and 409 quota still map as before', () => {
    expect(fromResponse(res(400), { message: 'x' })).toBeInstanceOf(BadRequestError);
    expect(fromResponse(res(409), { code: 'DOMAIN.QUOTA_EXCEEDED' })).toBeInstanceOf(QuotaExceededError);
  });
});
