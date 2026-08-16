/**
 * ConsultationStatus wiring gate (TASK-711, session state machine).
 *
 * This is the gate that makes another dead enum member (A-46: `CLOSED`/
 * `REOPENED` existed for years with zero live writers) STRUCTURALLY
 * impossible. It asserts, behaviourally (via `ConsultationEntity.
 * canTransitionTo` — never by importing the private `CONSULTATION_TRANSITIONS`
 * map), that every `ConsultationStatus` member is reachable as a `to` from
 * SOME other member, with exactly two documented exceptions:
 *
 *   - `OPEN`   — a consultation is CREATED in `OPEN`, never transitioned into
 *                it (state-machine.md §2).
 *   - `CLOSED` — SUPERSEDED before ever going live (split into
 *                `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE`, state-machine.md §1a).
 *                Retained in the enum only because Postgres cannot drop a
 *                value; deliberately and permanently never a `transitionTo`
 *                target again.
 *
 * DO NOT delete this test as "redundant" with `ConsultationEntity.
 * transitions.test.ts` — that suite proves the matrix is IMPLEMENTED
 * correctly; this one proves it is COMPLETE (no enum member left unwired),
 * which is exactly the property that would have caught A-46 before it shipped.
 */
import { describe, it, expect } from 'vitest';
import { ConsultationEntity, IConsultationEntity } from '../../entities/generated/core/ConsultationEntity';
import { ConsultationStatus, ResourceStatusType } from '../../enums';

const ALL_STATUSES: ConsultationStatus[] = Object.values(ConsultationStatus);

// The two documented, permanent exceptions — see the file doc above.
const NEVER_A_TARGET: ReadonlySet<ConsultationStatus> = new Set([ConsultationStatus.OPEN, ConsultationStatus.CLOSED]);

function createEntity(status: ConsultationStatus): ConsultationEntity {
  return new ConsultationEntity({
    id: 'wiring-gate-fixture',
    tenantId: 'tenant-wiring-gate',
    patientId: 'patient-1',
    appointmentDate: new Date('2026-08-16'),
    doctorId: 'doctor-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status,
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
  } as IConsultationEntity);
}

describe('ConsultationStatus wiring gate — every member is a matrix target, or documented as never-targeted', () => {
  it('every ConsultationStatus member is reachable as a `to` from some other member, except OPEN/CLOSED', () => {
    const unreachable: ConsultationStatus[] = [];

    for (const to of ALL_STATUSES) {
      if (NEVER_A_TARGET.has(to)) continue;

      const reachableFromSomewhere = ALL_STATUSES.some((from) => {
        if (from === to) return false; // a self-pair is an idempotent no-op, not a "wired" edge.
        return createEntity(from).canTransitionTo(to);
      });

      if (!reachableFromSomewhere) unreachable.push(to);
    }

    expect(
      unreachable,
      `The following ConsultationStatus member(s) are never a legal 'to' in CONSULTATION_TRANSITIONS ` +
        `(ConsultationEntity.ts) and are NOT in the documented NEVER_A_TARGET allow-list: ${unreachable.join(', ')}. ` +
        `Either wire a transition into the matrix (state-machine.md §2) or add the member to the allow-list ` +
        `with a documented rationale — an unwired member is exactly the A-46 defect this gate exists to catch.`,
    ).toEqual([]);
  });

  it('the never-a-target allow-list is EXACTLY {OPEN, CLOSED} — not a place to quietly grow', () => {
    expect(new Set(NEVER_A_TARGET)).toEqual(new Set([ConsultationStatus.OPEN, ConsultationStatus.CLOSED]));
  });

  it('every enum member still exists as a `from` this test enumerates (sanity: catches an enum member silently dropped)', () => {
    // The full Cartesian product this file exercises must equal the enum's
    // OWN member count — otherwise the two `it`s above could pass vacuously
    // over a shrunk enum.
    expect(ALL_STATUSES.length).toBeGreaterThanOrEqual(12);
  });
});
