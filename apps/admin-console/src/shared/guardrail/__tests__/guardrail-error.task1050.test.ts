/**
 * TASK-1050 W3b — classifying a failed call as a guardrail outcome. The console sees the gateway's
 * house envelope through `GatewayError.details` (W2b relays TEXT's problem members at the top level)
 * and, inside the consultation playground, the SDK's typed errors (`GuardrailBlockedError`, …),
 * which it recognises by NAME so a stale SDK build never breaks an `instanceof`.
 */
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import { classifyGuardrailError } from '../guardrail-error';

const blockedNotice: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'n-block',
  type: 'guardrail.blocked',
  direction: 'outbound',
  action: 'block',
  checks: [{ checkId: 'leakage_judge', category: 'system_prompt', severity: 'high' }],
  itemIds: ['item-9'],
  messageKey: 'guardrail.blocked.outbound',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.outbound'],
  requiresAcknowledgement: false,
  resumable: true,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

describe('classifyGuardrailError', () => {
  it('reads a relayed 422 block with its notice and legacy code', () => {
    const error = new GatewayError(422, 'blocked', undefined, {
      statusCode: 422,
      code: 'CONTENT_BLOCKED',
      type: 'urn:hope:problem:guardrail-blocked',
      guardrailNotice: blockedNotice,
      guardrailEvaluationIds: ['e1', 'e2'],
    });
    expect(classifyGuardrailError(error)).toEqual({ kind: 'blocked', code: 'CONTENT_BLOCKED', notice: blockedNotice, evaluationIds: ['e1', 'e2'] });
  });

  it('reads an older gateway 422 that carries only error_code CONTENT_BLOCKED_NOT_MEDICAL', () => {
    const error = new GatewayError(422, 'x', undefined, { error_code: 'CONTENT_BLOCKED_NOT_MEDICAL', detail: 'fixed' });
    expect(classifyGuardrailError(error)).toMatchObject({ kind: 'blocked', code: 'CONTENT_BLOCKED_NOT_MEDICAL', notice: null });
  });

  it('drops a notice with free text but keeps the block', () => {
    const error = new GatewayError(422, 'x', undefined, {
      type: 'urn:hope:problem:guardrail-blocked',
      guardrailNotice: { ...blockedNotice, defaultMessage: 'the injected text' },
    });
    expect(classifyGuardrailError(error)).toMatchObject({ kind: 'blocked', notice: null });
  });

  it('reads the egress-redaction 503 as a distinct retryable outcome', () => {
    const error = new GatewayError(503, 'x', undefined, {
      code: 'EGRESS_REDACTION_UNAVAILABLE',
      retryable: true,
      processingReason: 'EGRESS_REDACTION_UNAVAILABLE',
    });
    expect(classifyGuardrailError(error)).toMatchObject({ kind: 'redaction_unavailable' });
  });

  it('reads a 409 GUARDRAIL_HOLD as a hold', () => {
    const error = new GatewayError(409, 'held', undefined, { code: 'GUARDRAIL_HOLD' });
    expect(classifyGuardrailError(error)).toMatchObject({ kind: 'hold' });
  });

  it('recognises the SDK typed errors by name', () => {
    const sdkBlock = Object.assign(new Error('blocked'), {
      name: 'GuardrailBlockedError',
      notice: blockedNotice,
      evaluationIds: ['e'],
      context: { code: 'CONTENT_BLOCKED' },
    });
    expect(classifyGuardrailError(sdkBlock)).toEqual({ kind: 'blocked', code: 'CONTENT_BLOCKED', notice: blockedNotice, evaluationIds: ['e'] });
    const sdkEgress = Object.assign(new Error('x'), { name: 'EgressRedactionUnavailableError', context: {} });
    expect(classifyGuardrailError(sdkEgress)).toMatchObject({ kind: 'redaction_unavailable' });
    const sdkHold = Object.assign(new Error('x'), { name: 'GuardrailHoldError', notice: blockedNotice, context: {} });
    expect(classifyGuardrailError(sdkHold)).toMatchObject({ kind: 'hold', notice: blockedNotice });
  });

  it('returns null for anything else', () => {
    expect(classifyGuardrailError(new GatewayError(422, 'x', undefined, { code: 'MODEL_NOT_SELECTED' }))).toBeNull();
    expect(classifyGuardrailError(new GatewayError(500, 'x'))).toBeNull();
    expect(classifyGuardrailError(new Error('boom'))).toBeNull();
    expect(classifyGuardrailError(undefined)).toBeNull();
  });
});
