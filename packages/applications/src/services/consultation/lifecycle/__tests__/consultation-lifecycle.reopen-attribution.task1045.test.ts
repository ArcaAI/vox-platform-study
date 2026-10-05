/**
 * TASK-1045 lane W6-SVC — WHOSE reopen it is, now that a service account may reopen.
 *
 * A machine is never recorded as the clinician (TASK-933). A service account that names nobody
 * reopens for the clinician the ROW names; one that names a clinician follows the close/approve
 * rule (any clinician of its working tenant, membership asserted — 404 outside it). A human that
 * names nobody keeps the historical actor (themselves); a human or API key that NAMES someone is
 * held to the same rule as close.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';
import { ConsultationLifecycleService } from '../consultation-lifecycle.service';

const TENANT = 'tenant-1';
const ID = 'c-1';
const DOCTOR = 'doctor-1';
const OTHER_DOCTOR = 'doctor-2';
const SVC_ACCOUNT_ID = 'svc-1';
const API_KEY_ID = 'key-1';

type Row = ConstructorParameters<typeof ConsultationEntity>[0];

function closedRow(): ConsultationEntity {
  return new ConsultationEntity({
    id: ID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: DOCTOR,
    departmentId: null,
    appointmentDate: new Date('2026-10-05'),
    status: ConsultationStatus.CLOSED_INCOMPLETE,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: 1,
    segmentSeqHead: 0,
    version: 3,
    createdAt: new Date('2026-10-05T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
  } as Row);
}

function harness(principal: { user?: { id: string; roles: string[] }; serviceAccount?: { id: string } }, opts: { member?: boolean } = {}) {
  const row = closedRow();
  const written: ConsultationEntity[] = [];
  const consultations = {
    findByIdOrNull: vi.fn(async () => row),
    updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => {
      written.push(entity);
      return entity;
    }),
  };
  const values: Record<string, unknown> = { tenantId: TENANT, ...principal };
  const clsService = { get: vi.fn((key: string) => values[key]), set: vi.fn(), getId: vi.fn(() => 'req-1') };
  const events = { publish: vi.fn(async () => undefined) };
  const member = opts.member ?? true;
  const userRoleAssignmentRepository = {
    findFirst: vi.fn(async () => (member ? { id: 'ura-1' } : null)),
    findAll: vi.fn(async () => []),
  };
  const userDepartmentRepository = { findFirst: vi.fn(async () => (member ? { id: 'ud-1' } : null)) };
  const userRepository = { findFirst: vi.fn(async () => null) };

  const service = new ConsultationLifecycleService(
    consultations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    events as never,
    { emit: vi.fn() } as never,
    clsService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    userRoleAssignmentRepository as never,
    userDepartmentRepository as never,
    userRepository as never,
  );
  return { service, written, userRoleAssignmentRepository };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('ConsultationLifecycleService.reopen — attribution', () => {
  it('a service account naming nobody reopens for the row`s clinician, never as itself or "system"', async () => {
    const h = harness({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await h.service.reopen(ID, { expectedVersion: 3 });

    expect(h.written[0]?.status).toBe(ConsultationStatus.OPEN);
    expect(h.written[0]?.updatedBy).toBe(DOCTOR);
    expect(h.written[0]?.lastTransition?.actor).toBe(DOCTOR);
  });

  it('a service account naming a clinician of its tenant reopens for that clinician', async () => {
    const h = harness({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await h.service.reopen(ID, {
      expectedVersion: 3,
      clinicianUserId: OTHER_DOCTOR,
      caller: { isMachine: true, serviceAccountId: SVC_ACCOUNT_ID },
    });

    expect(h.written[0]?.updatedBy).toBe(OTHER_DOCTOR);
    expect(h.written[0]?.lastTransition?.actor).toBe(OTHER_DOCTOR);
  });

  it('a named clinician outside the tenant is 404 and nothing is written', async () => {
    const h = harness({ serviceAccount: { id: SVC_ACCOUNT_ID } }, { member: false });

    const error = await rejectionOf(
      h.service.reopen(ID, { expectedVersion: 3, clinicianUserId: OTHER_DOCTOR, caller: { isMachine: true, serviceAccountId: SVC_ACCOUNT_ID } }),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(h.written).toHaveLength(0);
  });

  it('an API key may name only the human it is bound to (400 CLINICIAN_NOT_ALLOWED otherwise)', async () => {
    const h = harness({ user: { id: DOCTOR, roles: [] } });

    const error = await rejectionOf(
      h.service.reopen(ID, { expectedVersion: 3, clinicianUserId: OTHER_DOCTOR, caller: { isMachine: true, apiKeyId: API_KEY_ID, userId: DOCTOR } }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code?: string }).code).toBe('CLINICIAN_NOT_ALLOWED');
    expect(h.written).toHaveLength(0);
  });

  it('a human naming nobody is unchanged: the actor is the caller', async () => {
    const h = harness({ user: { id: OTHER_DOCTOR, roles: [] } });

    await h.service.reopen(ID, { expectedVersion: 3 });

    expect(h.written[0]?.updatedBy).toBe(OTHER_DOCTOR);
    expect(h.written[0]?.lastTransition?.actor).toBe(OTHER_DOCTOR);
    expect(h.userRoleAssignmentRepository.findFirst).not.toHaveBeenCalled();
  });
});
