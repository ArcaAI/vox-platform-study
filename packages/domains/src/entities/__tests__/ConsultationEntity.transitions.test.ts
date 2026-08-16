/**
 * ConsultationEntity — session state machine (TASK-711)
 *
 * Table-driven over the FULL Cartesian product of the 12 adopted
 * `ConsultationStatus` members (144 pairs), reproducing the legality matrix
 * from `docs/implementation/TASK-711-Session-State-Machine/state-machine.md`
 * §2 verbatim as test data (NOT imported from the implementation — this test
 * is the independent source of truth the implementation must satisfy).
 *
 * Revised 2026-08-16 for the owner's Q1 decision: `CLOSED` is SUPERSEDED
 * (never a legal `to` — it stays in the Cartesian product only so its
 * illegal/self-only behavior is asserted) and split into `CLOSED_COMPLETE`
 * / `CLOSED_INCOMPLETE`.
 *
 * `PAUSED` is deliberately absent from `ConsultationStatus` (see
 * state-machine.md §1) so it is out of the Cartesian product entirely.
 */
import { describe, it, expect } from 'vitest';
import { ConsultationEntity, IConsultationEntity } from '../generated/core/ConsultationEntity';
import { ConsultationStatus, ResourceStatusType } from '../../enums';

const ALL_STATUSES: ConsultationStatus[] = [
  ConsultationStatus.OPEN,
  ConsultationStatus.PRIMED,
  ConsultationStatus.RECORDING,
  ConsultationStatus.DRAINING,
  ConsultationStatus.DRAFT_PENDING_SENSORS,
  ConsultationStatus.PENDING_REVIEW,
  ConsultationStatus.SIGNED,
  ConsultationStatus.TIMED_OUT,
  ConsultationStatus.CLOSED,
  ConsultationStatus.REOPENED,
  ConsultationStatus.CLOSED_COMPLETE,
  ConsultationStatus.CLOSED_INCOMPLETE,
];

// state-machine.md §2 — one row per legal, non-reflexive transition.
const LEGAL_TRANSITIONS: Array<[ConsultationStatus, ConsultationStatus]> = [
  [ConsultationStatus.OPEN, ConsultationStatus.PRIMED],
  [ConsultationStatus.PRIMED, ConsultationStatus.RECORDING],
  [ConsultationStatus.RECORDING, ConsultationStatus.DRAINING],
  [ConsultationStatus.DRAINING, ConsultationStatus.RECORDING],
  [ConsultationStatus.DRAINING, ConsultationStatus.DRAFT_PENDING_SENSORS],
  [ConsultationStatus.DRAINING, ConsultationStatus.PENDING_REVIEW],
  [ConsultationStatus.DRAFT_PENDING_SENSORS, ConsultationStatus.PENDING_REVIEW],
  [ConsultationStatus.DRAFT_PENDING_SENSORS, ConsultationStatus.SIGNED],
  [ConsultationStatus.PENDING_REVIEW, ConsultationStatus.SIGNED],
  [ConsultationStatus.PENDING_REVIEW, ConsultationStatus.TIMED_OUT],
  [ConsultationStatus.TIMED_OUT, ConsultationStatus.SIGNED],
  [ConsultationStatus.TIMED_OUT, ConsultationStatus.REOPENED],
  [ConsultationStatus.SIGNED, ConsultationStatus.REOPENED],
  [ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.REOPENED],
  [ConsultationStatus.CLOSED_INCOMPLETE, ConsultationStatus.REOPENED],
  [ConsultationStatus.REOPENED, ConsultationStatus.PENDING_REVIEW],
  [ConsultationStatus.SIGNED, ConsultationStatus.CLOSED_COMPLETE],
  [ConsultationStatus.TIMED_OUT, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.PRIMED, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.DRAINING, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.DRAFT_PENDING_SENSORS, ConsultationStatus.CLOSED_INCOMPLETE],
  [ConsultationStatus.REOPENED, ConsultationStatus.CLOSED_INCOMPLETE],
];

// Reserved but disabled — must throw naming the epic that will enable them,
// distinct from an ordinary illegal pair.
const RESERVED_DISABLED: Array<[ConsultationStatus, ConsultationStatus, string]> = [
  [ConsultationStatus.PENDING_REVIEW, ConsultationStatus.DRAFT_PENDING_SENSORS, 'note-sections'],
];

function isLegal(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

function reservedEpic(from: ConsultationStatus, to: ConsultationStatus): string | undefined {
  return RESERVED_DISABLED.find(([f, t]) => f === from && t === to)?.[2];
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
      const epic = reservedEpic(from, to);

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

      if (epic) {
        it(`${from} → ${to} is reserved-but-disabled (${epic})`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          expect(() => entity.transitionTo(to, 'actor-1', 'test-reason')).toThrow(epic);
        });
        continue;
      }

      if (isLegal(from, to)) {
        it(`${from} → ${to} is legal and records the change`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          const result = entity.transitionTo(to, 'actor-1', 'test-reason');

          expect(result).toBe(true);
          expect(entity.status).toBe(to);
          expect(entity.hasChanges).toBe(true);
          expect(entity.changes).toHaveProperty('status', to);
        });
      } else {
        it(`${from} → ${to} is illegal and throws naming both states`, () => {
          const entity = new ConsultationEntity(createInit({ status: from }));
          expect(() => entity.transitionTo(to, 'actor-1', 'test-reason')).toThrow();
          try {
            entity.transitionTo(to, 'actor-1', 'test-reason');
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

  it('the count of legal transitions equals the matrix row count (22)', () => {
    expect(LEGAL_TRANSITIONS.length).toBe(22);

    let legalCount = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        if (reservedEpic(from, to)) continue;
        const entity = new ConsultationEntity(createInit({ status: from }));
        try {
          entity.transitionTo(to, 'actor-1', 'test-reason');
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
    entity.transitionTo(ConsultationStatus.PRIMED, 'clinician-42', 'consent asserted');

    expect(entity.lastTransition).toMatchObject({
      from: ConsultationStatus.OPEN,
      to: ConsultationStatus.PRIMED,
      actor: 'clinician-42',
      reason: 'consent asserted',
    });
  });

  it('does not update lastTransition on a self-transition no-op', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    entity.transitionTo(ConsultationStatus.PRIMED, 'clinician-42', 'first');
    entity.transitionTo(ConsultationStatus.PRIMED, 'someone-else', 'second');

    expect(entity.lastTransition).toMatchObject({ actor: 'clinician-42', reason: 'first' });
  });
});

describe('ConsultationEntity.canTransitionTo', () => {
  it('returns true for every legal pair and for a self-transition', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      const entity = new ConsultationEntity(createInit({ status: from }));
      expect(entity.canTransitionTo(to)).toBe(true);
    }
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    expect(entity.canTransitionTo(ConsultationStatus.OPEN)).toBe(true);
  });

  it('returns false for an illegal pair and for a reserved-disabled pair, without throwing', () => {
    const entity = new ConsultationEntity(createInit({ status: ConsultationStatus.OPEN }));
    expect(entity.canTransitionTo(ConsultationStatus.SIGNED)).toBe(false);

    const reserved = new ConsultationEntity(createInit({ status: ConsultationStatus.PENDING_REVIEW }));
    expect(reserved.canTransitionTo(ConsultationStatus.DRAFT_PENDING_SENSORS)).toBe(false);
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

  it('transitioning to SIGNED clears degradedReasons as a side effect', () => {
    const entity = new ConsultationEntity(
      createInit({ status: ConsultationStatus.PENDING_REVIEW, degradedReasons: ['mcp_degraded', 'policy_degraded'] }),
    );
    entity.transitionTo(ConsultationStatus.SIGNED, 'clinician-1', 'approveSummary');

    expect(entity.degradedReasons).toEqual([]);
  });
});
