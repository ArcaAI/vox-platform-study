/**
 * TASK-1050 W0 — mapper write rules for the three guardrail models and the
 * `ContextItem.guardrailStatus` side-channel column.
 *
 *   • `_version` is DB-owned on all three (GuardrailNotice is OCC-written), and none of the
 *     three has a `resourceStatus*` column (MODELS_WITHOUT_SOFT_DELETE) — both are stripped;
 *   • the withheld-output ciphertext survives the mapper as a Buffer (the generic walk would
 *     otherwise destructure it into a `{0: byte, …}` map);
 *   • `ContextItem.guardrailStatus` is written on CREATE (a WITHHELD placeholder), but never by
 *     an entity UPDATE: it is outside OCC (OD-21).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { GuardrailEvaluationEntityMapper } from '../GuardrailEvaluationEntityMapper';
import { GuardrailNoticeEntityMapper } from '../GuardrailNoticeEntityMapper';
import { GuardrailPolicyRevisionEntityMapper } from '../GuardrailPolicyRevisionEntityMapper';
import { ContextItemEntityMapper } from '../ContextItemEntityMapper';
import { GuardrailEvaluationFactory } from '../../../../factories/generated/core/GuardrailEvaluationFactory';
import { GuardrailNoticeFactory } from '../../../../factories/generated/core/GuardrailNoticeFactory';
import { GuardrailPolicyRevisionFactory } from '../../../../factories/generated/core/GuardrailPolicyRevisionFactory';
import { ContextItemFactory } from '../../../../factories/generated/core/ContextItemFactory';
import { ContextItemType, GuardrailDecision, GuardrailDirection, GuardrailItemStatus, GuardrailNoticeType } from '../../../../enums';

const NOT_WRITABLE = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

const evaluation = () =>
  GuardrailEvaluationFactory.CreateGuardrailEvaluation({
    id: '0199b0a0-0000-7000-8000-000000000001',
    tenantId: 't-1',
    requestId: 'req-1',
    caller: 'text.generate',
    direction: GuardrailDirection.OUTBOUND,
    decision: GuardrailDecision.BLOCK,
    checks: [{ checkId: 'safety.violence', verdict: 'flag', actionTaken: 'block' }],
    policyVersion: 'pv-1',
    noticeIds: ['n-1'],
    encryptedWithheldContent: Buffer.from('vault:v3:Y2lwaGVy', 'utf8'),
    keyVersion: 3,
    at: new Date('2026-10-07T10:00:00Z'),
  });

const notice = () =>
  GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: 't-1',
    consultationId: 'c-1',
    type: GuardrailNoticeType.WARNING,
    direction: GuardrailDirection.INBOUND,
    action: 'warn',
    checks: [{ checkId: 'injection', category: 'prompt_injection', severity: 'high' }],
    itemIds: ['ci-1', 'ci-2'],
    messageKey: 'guardrail.warning.generic',
    severity: 'high',
    policyVersion: 'pv-1',
    dedupeKey: 'c-1|injection|ci-1|pv-1',
  });

describe('Guardrail mappers — DB-owned and absent columns are never written', () => {
  it('GuardrailEvaluation: strips version + resourceStatus*, keeps the ciphertext Buffer', () => {
    const mapper = GuardrailEvaluationEntityMapper.getInstance();
    const row = mapper.toPersistence(evaluation()) as any;
    for (const field of NOT_WRITABLE) expect(row, field).not.toHaveProperty(field);
    expect(row.id).toBe('0199b0a0-0000-7000-8000-000000000001');
    expect(Buffer.isBuffer(row.encryptedWithheldContent)).toBe(true);
    expect(Buffer.from(row.encryptedWithheldContent).toString('utf8')).toBe('vault:v3:Y2lwaGVy');
    expect(row.noticeIds).toEqual(['n-1']);
    expect(row.checks).toEqual([{ checkId: 'safety.violence', verdict: 'flag', actionTaken: 'block' }]);
  });

  it('GuardrailEvaluation: a read round-trips the ciphertext as a Buffer', () => {
    const mapper = GuardrailEvaluationEntityMapper.getInstance();
    const entity = mapper.toDomainEntity({ ...(mapper.toPersistence(evaluation()) as any), version: 1 });
    expect(Buffer.isBuffer(entity.encryptedWithheldContent)).toBe(true);
    expect(entity.version).toBe(1);
  });

  it('GuardrailNotice: strips version on create AND on a tracked update', () => {
    const mapper = GuardrailNoticeEntityMapper.getInstance();
    const entity = notice();
    for (const field of NOT_WRITABLE) expect(mapper.toPersistence(entity), field).not.toHaveProperty(field);

    const read = mapper.toDomainEntity({ ...(mapper.toPersistence(entity) as any), version: 4 });
    read.acknowledge({ by: 'u-1', via: 'notice' });
    const changes = mapper.toPersistenceChanges(read) as any;
    expect(changes).not.toHaveProperty('version');
    expect(changes).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'u-1', acknowledgedVia: 'notice' });
  });

  it('GuardrailPolicyRevision: strips version + resourceStatus*', () => {
    const mapper = GuardrailPolicyRevisionEntityMapper.getInstance();
    const row = mapper.toPersistence(
      GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({
        tenantId: '00000000-0000-0000-0000-000000000000',
        aiModelId: 'model-1',
        policyKey: 'criteria.violence',
        value: { text: 'Role and task …' },
        valueHash: 'sha256:abc',
        actorId: 'u-admin',
        reason: 'seed',
      }),
    ) as any;
    for (const field of NOT_WRITABLE) expect(row, field).not.toHaveProperty(field);
    expect(row.value).toEqual({ text: 'Role and task …' });
  });
});

describe('ContextItemEntityMapper — guardrailStatus is outside OCC (OD-21)', () => {
  const mapper = new ContextItemEntityMapper();

  it('a create carries a supplied WITHHELD marker', () => {
    const item = ContextItemFactory.CreateContextItem({
      tenantId: 't-1',
      consultationId: 'c-1',
      type: ContextItemType.SUMMARY,
      guardrailStatus: GuardrailItemStatus.WITHHELD,
    });
    expect((mapper.toPersistence(item) as any).guardrailStatus).toBe(GuardrailItemStatus.WITHHELD);
  });

  it('an entity update never writes the marker, even when the read row carries one', () => {
    const read = mapper.toDomainEntity({
      ...(mapper.toPersistence(
        ContextItemFactory.CreateContextItem({ tenantId: 't-1', consultationId: 'c-1', type: ContextItemType.SUMMARY }),
      ) as any),
      version: 3,
      guardrailStatus: GuardrailItemStatus.WARNED,
    });
    expect(read.guardrailStatus).toBe(GuardrailItemStatus.WARNED);
    read.documentKey = 'soap';
    const changes = mapper.toPersistenceChanges(read) as any;
    expect(changes).toMatchObject({ documentKey: 'soap' });
    expect(changes).not.toHaveProperty('guardrailStatus');
    expect(changes).not.toHaveProperty('version');
  });
});
