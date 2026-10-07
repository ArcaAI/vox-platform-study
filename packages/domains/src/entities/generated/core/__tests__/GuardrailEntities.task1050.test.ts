/**
 * TASK-1050 W0 — the guardrail evaluation / notice / policy-revision entities and factories,
 * plus the `ContextItem.guardrailStatus` side-channel marker.
 *
 * What is pinned:
 *   • a GuardrailEvaluation's id is the caller's `evaluationId` (guardrail mints it before it
 *     answers, and the gateway write is idempotent on it) — the factory never invents one;
 *   • a GuardrailNotice starts OPEN, and acknowledge / resolve move it forward only;
 *   • a GuardrailPolicyRevision carries one of the four reasons;
 *   • a ContextItem reads CLEAN unless told otherwise, and exposes no public setter for the
 *     marker (the only writer is `ContextItemRepository.setGuardrailStatus`).
 */
import { describe, it, expect } from 'vitest';
import { GuardrailEvaluationFactory } from '../../../../factories/generated/core/GuardrailEvaluationFactory';
import { GuardrailNoticeFactory } from '../../../../factories/generated/core/GuardrailNoticeFactory';
import { GuardrailPolicyRevisionFactory } from '../../../../factories/generated/core/GuardrailPolicyRevisionFactory';
import { ContextItemFactory } from '../../../../factories/generated/core/ContextItemFactory';
import {
  ContextItemType,
  GuardrailDecision,
  GuardrailDirection,
  GuardrailItemStatus,
  GuardrailNoticeStatus,
  GuardrailNoticeType,
} from '../../../../enums';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const EVALUATION_ID = '0199b0a0-0000-7000-8000-000000000001';

const evaluationProps = (overrides: Record<string, unknown> = {}) => ({
  id: EVALUATION_ID,
  tenantId: 't-1',
  requestId: 'req-1',
  consultationId: 'c-1',
  caller: 'text.generate',
  direction: GuardrailDirection.OUTBOUND,
  decision: GuardrailDecision.WARN,
  checks: [{ checkId: 'safety.self_harm', verdict: 'flag', actionTaken: 'warn', model: 'granite', latencyMs: 12, regionKeys: [] }],
  policyVersion: 'pv-1',
  at: new Date('2026-10-07T10:00:00Z'),
  ...overrides,
});

const noticeProps = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 't-1',
  consultationId: 'c-1',
  type: GuardrailNoticeType.WARNING,
  direction: GuardrailDirection.OUTBOUND,
  action: 'warn',
  checks: [{ checkId: 'safety.self_harm', category: 'self_harm', severity: 'medium' }],
  itemIds: ['ci-1'],
  messageKey: 'guardrail.warning.generic',
  severity: 'medium',
  policyVersion: 'pv-1',
  dedupeKey: 'c-1|safety.self_harm|ci-1|pv-1',
  ...overrides,
});

describe('GuardrailEvaluationFactory', () => {
  it('keeps the caller-supplied evaluationId as the row id', () => {
    const evaluation = GuardrailEvaluationFactory.CreateGuardrailEvaluation(evaluationProps());
    expect(evaluation.id).toBe(EVALUATION_ID);
    expect(evaluation.direction).toBe(GuardrailDirection.OUTBOUND);
    expect(evaluation.decision).toBe(GuardrailDecision.WARN);
    expect(evaluation.noticeIds).toEqual([]);
    expect(evaluation.encryptedWithheldContent).toBeNull();
    expect(() => evaluation.validate()).not.toThrow();
  });

  it('refuses to create an evaluation without its evaluationId', () => {
    expect(() => GuardrailEvaluationFactory.CreateGuardrailEvaluation(evaluationProps({ id: '' }) as never)).toThrow(/evaluationId/);
  });

  it('validate() requires requestId, caller and policyVersion', () => {
    for (const field of ['requestId', 'caller', 'policyVersion']) {
      const evaluation = GuardrailEvaluationFactory.CreateGuardrailEvaluation(evaluationProps({ [field]: '' }));
      expect(() => evaluation.validate(), field).toThrow();
    }
  });

  it('validate() refuses withheld content on anything but an outbound block', () => {
    const evaluation = GuardrailEvaluationFactory.CreateGuardrailEvaluation(
      evaluationProps({ decision: GuardrailDecision.WARN, encryptedWithheldContent: Buffer.from('vault:v1:abc') }),
    );
    expect(() => evaluation.validate()).toThrow(/withheld/i);

    const outboundBlock = GuardrailEvaluationFactory.CreateGuardrailEvaluation(
      evaluationProps({ decision: GuardrailDecision.BLOCK, encryptedWithheldContent: Buffer.from('vault:v1:abc'), keyVersion: 1 }),
    );
    expect(() => outboundBlock.validate()).not.toThrow();
  });
});

describe('GuardrailNoticeFactory + lifecycle', () => {
  it('mints a UUIDv7 noticeId and starts OPEN', () => {
    const notice = GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps());
    expect(notice.id).toMatch(UUID_V7);
    expect(notice.status).toBe(GuardrailNoticeStatus.OPEN);
    expect(notice.requiresAcknowledgement).toBe(false);
    expect(notice.resumable).toBe(false);
    expect(notice.acknowledgedAt).toBeNull();
    expect(() => notice.validate()).not.toThrow();
  });

  it('validate() requires a dedupeKey and a messageKey', () => {
    expect(() => GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps({ dedupeKey: '' })).validate()).toThrow();
    expect(() => GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps({ messageKey: '' })).validate()).toThrow();
  });

  it('acknowledge() records who, how and when, and is tracked as a change', () => {
    const notice = GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps());
    const at = new Date('2026-10-07T11:00:00Z');
    notice.acknowledge({ by: 'u-doctor', via: 'approve', at });
    expect(notice.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
    expect(notice.acknowledgedBy).toBe('u-doctor');
    expect(notice.acknowledgedVia).toBe('approve');
    expect(notice.acknowledgedAt).toEqual(at);
    expect(notice.hasChanges).toBe(true);
  });

  it('acknowledge() refuses an unknown channel and a resolved notice', () => {
    const notice = GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps());
    expect(() => notice.acknowledge({ by: 'u', via: 'email' as never })).toThrow();
    notice.resolve({ by: 'u', resolution: 'item_excluded' });
    expect(() => notice.acknowledge({ by: 'u', via: 'notice' })).toThrow();
  });

  it('resolve() closes the notice with one of the three resolutions', () => {
    const notice = GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps({ type: GuardrailNoticeType.BLOCKED, action: 'block' }));
    notice.resolve({ by: 'u-doctor', resolution: 'item_edited' });
    expect(notice.status).toBe(GuardrailNoticeStatus.RESOLVED);
    expect(notice.resolution).toBe('item_edited');
    expect(notice.resolvedBy).toBe('u-doctor');
    expect(notice.resolvedAt).toBeInstanceOf(Date);
    expect(() => notice.resolve({ by: 'u', resolution: 'acknowledged' })).toThrow();
    expect(() => GuardrailNoticeFactory.CreateGuardrailNotice(noticeProps()).resolve({ by: 'u', resolution: 'ignore' as never })).toThrow();
  });
});

describe('GuardrailPolicyRevisionFactory', () => {
  it('creates an append-only SYSTEM revision', () => {
    const revision = GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({
      tenantId: SYSTEM_TENANT_ID,
      aiModelId: 'model-1',
      policyKey: 'judgeTemperature',
      value: 0,
      valueHash: 'sha256:abc',
      actorId: 'u-admin',
      reason: 'edit',
    });
    expect(revision.id).toMatch(UUID_V7);
    expect(revision.at).toBeInstanceOf(Date);
    expect(revision.restoredFromRevisionId).toBeNull();
    expect(() => revision.validate()).not.toThrow();
  });

  it('validate() refuses an unknown reason and a restore without its source', () => {
    const base = {
      tenantId: SYSTEM_TENANT_ID,
      aiModelId: 'model-1',
      policyKey: 'judgeTemperature',
      value: 0,
      valueHash: 'sha256:abc',
      actorId: 'u-admin',
    };
    expect(() => GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({ ...base, reason: 'oops' as never }).validate()).toThrow();
    expect(() => GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({ ...base, reason: 'restore' }).validate()).toThrow(/restoredFrom/);
    expect(() =>
      GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({ ...base, reason: 'restore', restoredFromRevisionId: 'rev-0' }).validate(),
    ).not.toThrow();
  });
});

describe('ContextItem.guardrailStatus', () => {
  const props = { tenantId: 't-1', consultationId: 'c-1', type: ContextItemType.RAW_SUMMARY };

  it('reads CLEAN when not supplied, and carries a supplied WITHHELD on create', () => {
    expect(ContextItemFactory.CreateContextItem(props).guardrailStatus).toBe(GuardrailItemStatus.CLEAN);
    expect(ContextItemFactory.CreateContextItem({ ...props, guardrailStatus: GuardrailItemStatus.WITHHELD }).guardrailStatus).toBe(
      GuardrailItemStatus.WITHHELD,
    );
  });

  it('has no public setter: the marker is never an entity change', () => {
    const item = ContextItemFactory.CreateContextItem(props);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(item), 'guardrailStatus');
    expect(descriptor?.get).toBeTypeOf('function');
    expect(descriptor?.set).toBeUndefined();
  });
});
