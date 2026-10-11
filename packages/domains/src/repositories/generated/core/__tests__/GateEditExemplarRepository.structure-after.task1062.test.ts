/**
 * TASK-1062 D-3 — `GateEditExemplar.structureAfter`, the structure-only exemplar column.
 *
 * Pinned here: the entity / factory / mapper carry the column (so a save persists it and a read
 * hydrates it), and the few-shot retrieval query only ever selects rows that HAVE it — a row mined
 * before the column existed (not yet backfilled) is never a retrieval candidate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GateEditExemplarFactory } from '../../../../factories';
import { GateEditExemplarEntityMapper } from '../../../../mappers';
import { GateEditExemplarRepository } from '../GateEditExemplarRepository';

const TENANT = 'tenant-1';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  tenantId: TENANT,
  consultationId: 'c-1',
  departmentId: null,
  visitType: null,
  gateDecision: 'APPROVED',
  qualitySignal: 'APPROVED_CLEAN',
  editDistance: 0,
  editDistanceRatio: 0,
  timeToSignSeconds: 10,
  redactedBefore: 'before',
  redactedAfter: 'Plan: metformin 500 mg',
  structureAfter: 'Plan: <DRUG> <DOSE>',
  contextItemId: null,
  modelName: null,
  promptTemplateId: null,
  curationStatus: 'PENDING',
  source: 'GATE',
  feedbackId: null,
  reasonCodes: [],
  targetKind: null,
  version: 1,
  createdAt: new Date('2026-10-11T00:00:00.000Z'),
  updatedAt: new Date('2026-10-11T00:00:00.000Z'),
  createdBy: null,
  updatedBy: null,
  metaData: null,
  ...overrides,
});

describe('GateEditExemplar.structureAfter (TASK-1062 D-3)', () => {
  it('the factory carries structureAfter onto the entity, null when omitted', () => {
    const withStructure = GateEditExemplarFactory.CreateGateEditExemplar({
      tenantId: TENANT,
      consultationId: 'c-1',
      gateDecision: 'APPROVED',
      qualitySignal: 'APPROVED_CLEAN',
      redactedAfter: 'Plan: metformin 500 mg',
      structureAfter: 'Plan: <DRUG> <DOSE>',
    });
    expect(withStructure.structureAfter).toBe('Plan: <DRUG> <DOSE>');

    const without = GateEditExemplarFactory.CreateGateEditExemplar({
      tenantId: TENANT,
      consultationId: 'c-1',
      gateDecision: 'APPROVED',
      qualitySignal: 'APPROVED_CLEAN',
    });
    expect(without.structureAfter).toBeNull();
  });

  it('the mapper persists structureAfter on create and on a tracked update, and hydrates it on read', () => {
    const mapper = GateEditExemplarEntityMapper.getInstance();
    const entity = mapper.toDomainEntity(row({ structureAfter: null }) as any);
    expect(entity.structureAfter).toBeNull();

    entity.structureAfter = 'Plan: <DRUG> <DOSE>';
    expect(mapper.toPersistenceChanges(entity)).toEqual(expect.objectContaining({ structureAfter: 'Plan: <DRUG> <DOSE>' }));
    expect(mapper.toPersistence(entity)).toEqual(expect.objectContaining({ structureAfter: 'Plan: <DRUG> <DOSE>' }));
    expect(mapper.toDomainEntity(row() as any).structureAfter).toBe('Plan: <DRUG> <DOSE>');
  });

  describe('findTopForRetrieval', () => {
    let findMany: ReturnType<typeof vi.fn>;
    let repo: GateEditExemplarRepository;

    beforeEach(() => {
      findMany = vi.fn(async () => [row()]);
      const unitOfWork = { getDatabaseService: () => ({ gateEditExemplar: { findMany } }) };
      repo = new GateEditExemplarRepository(unitOfWork as never);
    });

    it('selects only rows that carry a structure-only exemplar', async () => {
      const result = await repo.findTopForRetrieval({ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', limit: 3 });

      expect(findMany).toHaveBeenCalledTimes(1);
      const where = findMany.mock.calls[0][0].where;
      expect(where).toEqual(expect.objectContaining({ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', structureAfter: { not: null } }));
      expect(result[0]?.structureAfter).toBe('Plan: <DRUG> <DOSE>');
    });

    it('the corpus export is NOT narrowed — it reads every row, structure or not', async () => {
      await repo.findForCorpusExport({ tenantId: TENANT, limit: 10 });
      expect(findMany.mock.calls[0][0].where).not.toHaveProperty('structureAfter');
    });
  });
});
