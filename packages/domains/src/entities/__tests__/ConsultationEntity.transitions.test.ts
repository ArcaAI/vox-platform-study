/**
 * ConsultationEntity — consultation lifecycle state machine
 *
 * Table-driven over the FULL Cartesian product of the seven
 * `ConsultationStatus` members (49 pairs), reproducing the legality matrix
 * verbatim as test data (NOT imported from the implementation — this test is
 * the independent source of truth the implementation must satisfy).
 *
 * CLOSED_COMPLETE → OPEN is legal only under the tenant reopen policy; it is
 * exercised here with `allowClosedCompleteReopen: true`. The processing guard
 * on STOPPED → APPROVED is covered by `ConsultationEntity.lifecycle.task1045.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ConsultationEntity, IConsultationEntity } from '../generated/core/ConsultationEntity';
import { ConsultationStatus, ResourceStatusType } from '../../enums';

const ALL_STATUSES: ConsultationStatus[] = [
  ConsultationStatus.OPEN,
  ConsultationStatus.RECORDING,
  ConsultationStatus.PAUSED,
  ConsultationStatus.STOPPED,
  ConsultationStatus.APPROVED,
  ConsultationStatus.CLOSED_COMPLETE,
  ConsultationStatus.CLOSED_INCOMPLETE,
];

// One row per legal, non-reflexive transition.
const LEGAL_TRANSITIONS: Array<[ConsultationStatus, ConsultationStatus]> = [
  [ConsultationStatus.OPEN, ConsultationStatus.RECORDING],
  [ConsultationStatus.OPEN, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.RECORDING, ConsultationStatus.PAUSED],
  [ConsultationStatus.RECORDING, ConsultationStatus.STOPPED],
  [ConsultationStatus.RECORDING, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.PAUSED, ConsultationStatus.RECORDING],
  [ConsultationStatus.PAUSED, ConsultationStatus.STOPPED],
  [ConsultationStatus.PAUSED, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.STOPPED, ConsultationStatus.RECORDING],
  [ConsultationStatus.STOPPED, ConsultationStatus.OPEN],
  [ConsultationStatus.STOPPED, ConsultationStatus.APPROVED],
  [ConsultationStatus.STOPPED, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE],
  [ConsultationStatus.CLOSED_INCOMPLETE, ConsultationStatus.OPEN],
  [ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.OPEN],
];

const POLICY = { allowClosedCompleteReopen: true };

function isLegal(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

function createInit(overrides: Partial<IConsultationEntity> = {}): IConsultationEntity {
  return {
    id: 'consultation-test-id',
    tenantId: 'tenant-test-id',
    patientId: 'patient-1',
    appointmentDate: new Date('2026-08-16'),
    doctorId: 'doctor-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: ConsultationStatus.OPEN,
    degradedReasons: [],
    createdAt: new Date('2026-08-16'),
    updatedAt: new Date('2026-08-16'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as IConsultationEntity;
}

describe('ConsultationEntity.transitionTo — full Cartesian legality matrix', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (from === to) {
        it(`${from} → ${to} (self) is an idempotent no-op`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          const result = entity.transitionTo(to, 'actor-1', 'test-reason');

          expect(result).toBe(false);
          expect(entity.status).toBe(from);
          expect(entity.hasChanges).toBe(false);
        });
        continue;
      }

      if (isLegal(from, to)) {
        it(`${from} → ${to} is legal and records the change`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          const result = entity.transitionTo(to, 'actor-1', 'test-reason', POLICY);

          expect(result).toBe(true);
          expect(entity.status).toBe(to);
          expect(entity.hasChanges).toBe(true);
          expect(entity.changes).toHaveProperty('status', to);
        });
      } else {
        it(`${from} → ${to} is illegal and throws naming both states`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          try {
            entity.transitionTo(to, 'actor-1', 'test-reason', POLICY);
            throw new Error('expected transitionTo to throw');
          } catch (err) {
            const message = (err as Error).message;
            expect(message).toContain(from);
            expect(message).toContain(to);
          }
        });
      }
    }
  }

  it('the count of legal transitions equals the matrix row count (15)', () => {
    expect(LEGAL_TRANSITIONS.length).toBe(15);

    let legalCount = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        const entity = new ConsultationEntity(createInit({ status: from }));
        try {
          entity.transitionTo(to, 'actor-1', 'test-reason', POLICY);
          legalCount += 1;
        } catch {
          // illegal — not counted
        }
      }
    }
    expect(legalCount).toBe(LEGAL_TRANSITIONS.length);
  });
});

describe('ConsultationEntity.transitionTo — actor/reason + WORM handoff', () => {
  it('records actor and reason on the entity for the caller to forward', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    entity.transitionTo(ConsultationStatus.RECORDING, 'clinician-42', 'start');

    expect(entity.lastTransition).toMatchObject({
      from: ConsultationStatus.OPEN,
      to: ConsultationStatus.RECORDING,
      actor: 'clinician-42',
      reason: 'start',
    });
  });

  it('does not update lastTransition on a self-transition no-op', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    entity.transitionTo(ConsultationStatus.RECORDING, 'clinician-42', 'first');
    entity.transitionTo(ConsultationStatus.RECORDING, 'someone-else', 'second');

    expect(entity.lastTransition).toMatchObject({ actor: 'clinician-42', reason: 'first' });
  });
});

describe('ConsultationEntity.canTransitionTo', () => {
  it('returns true for every legal pair and for a self-transition', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      const entity = new ConsultationEntity(createInit({ status: from }));
      expect(entity.canTransitionTo(to, POLICY)).toBe(true);
    }
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    expect(entity.canTransitionTo(ConsultationStatus.OPEN)).toBe(true);
  });

  it('returns false for an illegal pair without throwing', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    expect(entity.canTransitionTo(ConsultationStatus.APPROVED)).toBe(false);
  });
});

describe('ConsultationEntity.degradedReasons', () => {
  it('addDegradedReason appends without duplicates', () => {
    const entity = new ConsultationEntity(createInit({ degradedReasons: [] }));
    entity.addDegradedReason('mcp_degraded');
    entity.addDegradedReason('policy_degraded');
    entity.addDegradedReason('mcp_degraded');

    expect(entity.degradedReasons).toEqual(['mcp_degraded', 'policy_degraded']);
  });

  it('clearDegradedReasons empties the list', () => {
    const entity = new ConsultationEntity(createInit({ degradedReasons: ['mcp_degraded'] }));
    entity.clearDegradedReasons();

    expect(entity.degradedReasons).toEqual([]);
  });

  it('transitioning to APPROVED clears degradedReasons as a side effect', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.STOPPED, degradedReasons: ['mcp_degraded', 'policy_degraded'] }));
    entity.transitionTo(ConsultationStatus.APPROVED, 'clinician-1', 'approve');

    expect(entity.degradedReasons).toEqual([]);
  });
});
