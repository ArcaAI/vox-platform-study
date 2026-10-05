/**
 * TASK-1020 — one clinical encounter = one consultation (BP-1), and `open` is the only entry.
 *
 * What this file pins, each because it is a way the same-day return visit broke:
 *
 *  1. THE ENCOUNTER KEY (D-2/D-3). With an `externalRef` (the EMR event id) `open` matches on
 *     `(tenant, patient, doctor, externalRef)`: the same ref is the same row (retries and reconnects
 *     are safe), a NEW ref is a NEW consultation even when a same-day row exists, and a ref already
 *     used for another patient is 409 `EXTERNAL_REF_CONFLICT`. The ref is written to the column on
 *     CREATE (and still to the metadata marker, for readers that predate the column).
 *  2. THE LEGACY KEY (D-3/OD-3). Without a ref, `(tenant, patient, appointmentDate, doctor)` still
 *     applies — except that a caller who names the match (or an unrelated row) as its parent is
 *     explicitly following up, which creates a child. A terminal match is RETURNED with
 *     `recordable: false`, never auto-forked.
 *  3. THE DERIVED PARENT (OD-4). A `revisit` opened with no parent is chained to the latest
 *     same-patient, same-day consultation of ANY clinician. An explicit parent always wins.
 *  4. THE PARENT IS THE SAME PATIENT (D-5): 400 `PARENT_PATIENT_MISMATCH`.
 *  5. SIGNED DOCUMENTATION IS NOT RECORDED OVER (D-4/BP-2): `recording/start` on a row the matrix
 *     cannot move to RECORDING is 409 `CONSULTATION_NOT_RECORDABLE` whatever the kill-switch says;
 *     the switch-OFF bypass survives for `OPEN` alone.
 *  6. A RE-OPEN DOES NOT RE-GRANT CONSENT (D-6's intent: a revocation is honoured — the grant
 *     happens when a NEW encounter is created), and the day is the TENANT's day (BP-5/OD-8).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { encounterServiceDouble, lifecycleDouble } from './consultation-service.fixture';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { readExternalRef } from '../open-markers';
import { CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY } from '../../consultation-gates.constants';
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  CONSULTATION_APPOINTMENT_DAY_SETTINGS,
} from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';
const OTHER_DOCTOR = 'doctor-2';
const PATIENT = 'patient-1';

let seq = 0;
function row(overrides: Partial<Record<string, unknown>> = {}): ConsultationEntity {
  seq += 1;
  return new ConsultationEntity({
    id: `c-${seq}`,
    tenantId: TENANT,
    patientId: PATIENT,
    doctorId: DOCTOR,
    appointmentDate: new Date('2026-09-29'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    externalRef: null,
    status: ConsultationStatus.OPEN,
    degradedReasons: [],
    createdAt: new Date(`2026-09-29T0${seq % 10}:00:00Z`),
    updatedAt: new Date('2026-09-29T00:00:00Z'),
    createdBy: DOCTOR,
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as any);
}

describe('ConsultationService — TASK-1020 open encounter key and recordability', () => {
  let consultationRepository: any;
  let consentGrantService: any;
  let tenantSettings: any;
  let emit: ReturnType<typeof vi.fn>;
  let timeZone: unknown;
  let requirePrimed: boolean;

  const buildService = () =>
    new ConsultationService(
      consultationRepository,
      {} as any, // departmentRepository
      { findFirst: vi.fn().mockResolvedValue({ id: 'ura-1' }) } as any, // userRoleAssignmentRepository
      { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1' }) } as any, // userDepartmentRepository
      { findFirst: vi.fn().mockResolvedValue(null) } as any, // userRepository
      { emit } as any,
      {
        get: vi.fn((key: string) => {
          if (key === 'tenantId') return TENANT;
          if (key === 'user') return { id: DOCTOR, tenantId: TENANT };
          return null;
        }),
        set: vi.fn(),
      } as any,
      encounterServiceDouble(consultationRepository), // encounters
      lifecycleDouble(), // lifecycle
      undefined, // entitlements
      tenantSettings,
      undefined, // workflowDispatchService
      consentGrantService,
    );

  const open = (request: Partial<OpenConsultationRequest>) =>
    buildService().getOrCreate({ patientId: PATIENT, appointmentDate: '2026-09-29', ...request } as OpenConsultationRequest, DOCTOR);

  const created = (): ConsultationEntity => consultationRepository.create.mock.calls[0][0];

  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    emit = vi.fn();
    timeZone = undefined;
    requirePrimed = false;
    consultationRepository = {
      findByExternalRef: vi.fn().mockResolvedValue([]),
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findByPatientAndDate: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: ConsultationEntity) => entity),
      updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => entity),
    };
    consentGrantService = { ensureConsultationConsent: vi.fn().mockResolvedValue(undefined) };
    tenantSettings = {
      resolve: vi.fn((key: string) => ({
        key,
        value: key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY ? (timeZone ?? 'UTC') : requirePrimed,
        source: 'code-default',
      })),
      resolvePlatform: vi.fn((key: string) => ({ key, value: key === CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY ? requirePrimed : undefined })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. The encounter key ──────────────────────────────────────────────────
  describe('with an externalRef', () => {
    it('same ref → the same row (isNew false), nothing created, and the legacy key is not consulted', async () => {
      const morning = row({ externalRef: 'EVT-1', metadata: { externalRef: 'EVT-1' } });
      consultationRepository.findByExternalRef.mockResolvedValue([morning]);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(consultationRepository.findByExternalRef).toHaveBeenCalledWith(TENANT, 'EVT-1');
      expect(consultationRepository.findByUniqueKey).not.toHaveBeenCalled();
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(morning.id);
      expect(result.isNew).toBe(false);
      expect(result.externalRef).toBe('EVT-1');
      expect(result.recordable).toBe(true);
    });

    it('new ref on the same day → a NEW consultation chained to the latest same-day row (derived parent), even though a legacy match exists', async () => {
      const morning = row({ externalRef: 'EVT-1', status: ConsultationStatus.SIGNED });
      const otherClinicianLater = row({ doctorId: OTHER_DOCTOR, status: ConsultationStatus.CLOSED_COMPLETE });
      consultationRepository.findByUniqueKey.mockResolvedValue(morning);
      consultationRepository.findByPatientAndDate.mockResolvedValue([morning, otherClinicianLater]);

      const result = await open({ metadata: { externalRef: 'EVT-2', visitType: 'revisit' } });

      expect(consultationRepository.create).toHaveBeenCalledTimes(1);
      expect(created().externalRef).toBe('EVT-2');
      // The marker is still written, for every reader that predates the column.
      expect(readExternalRef(created().metadata)).toBe('EVT-2');
      // Latest same-patient same-day row, ANY clinician.
      expect(consultationRepository.findByPatientAndDate).toHaveBeenCalledWith(TENANT, PATIENT, new Date('2026-09-29'));
      expect(created().parentConsultationId).toBe(otherClinicianLater.id);
      expect(result.isNew).toBe(true);
      expect(result.visitType).toBe('revisit');
      expect(result.parentConsultationId).toBe(otherClinicianLater.id);
      expect(result.status).toBe(ConsultationStatus.OPEN);
      expect(result.recordable).toBe(true);
    });

    it('an explicit parent wins over the derived one', async () => {
      const explicitParent = row({ id: 'c-explicit' });
      consultationRepository.findById.mockResolvedValue(explicitParent);
      consultationRepository.findByPatientAndDate.mockResolvedValue([row(), row()]);

      await open({ parentConsultationId: 'c-explicit', metadata: { externalRef: 'EVT-3', visitType: 'revisit' } });

      expect(created().parentConsultationId).toBe('c-explicit');
      expect(consultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
    });

    it('a new-visit derives no parent', async () => {
      consultationRepository.findByPatientAndDate.mockResolvedValue([row()]);

      const result = await open({ metadata: { externalRef: 'EVT-4' } });

      expect(created().parentConsultationId).toBeNull();
      expect(result.visitType).toBe('new-visit');
      expect(consultationRepository.findByPatientAndDate).not.toHaveBeenCalled();
    });

    it('a racing open that loses the unique index returns the winner row (isNew false), not a 500', async () => {
      const winner = row({ externalRef: 'EVT-RACE', metadata: { externalRef: 'EVT-RACE' } });
      consultationRepository.findByExternalRef.mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);
      consultationRepository.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

      const result = await open({ metadata: { externalRef: 'EVT-RACE' } });

      expect(result.id).toBe(winner.id);
      expect(result.isNew).toBe(false);
    });

    it('a unique violation with no externalRef is rethrown untouched', async () => {
      const failure = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      consultationRepository.create.mockRejectedValueOnce(failure);

      await expect(open({})).rejects.toBe(failure);
    });

    it('a ref already used for ANOTHER patient is 409 EXTERNAL_REF_CONFLICT and nothing is written', async () => {
      consultationRepository.findByExternalRef.mockResolvedValue([row({ patientId: 'patient-9', externalRef: 'EVT-1' })]);

      const error = await open({ metadata: { externalRef: 'EVT-1' } }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'EXTERNAL_REF_CONFLICT' });
      expect(consultationRepository.create).not.toHaveBeenCalled();
    });
  });

  // ── 2. The legacy key ─────────────────────────────────────────────────────
  describe('without an externalRef', () => {
    it('a TERMINAL match is returned, not forked — with recordable:false', async () => {
      const signed = row({ status: ConsultationStatus.SIGNED });
      consultationRepository.findByUniqueKey.mockResolvedValue(signed);

      const result = await open({});

      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(signed.id);
      expect(result.isNew).toBe(false);
      expect(result.status).toBe(ConsultationStatus.SIGNED);
      expect(result.recordable).toBe(false);
      expect(result.externalRef).toBeNull();
    });

    it.each([
      ConsultationStatus.SIGNED,
      ConsultationStatus.CLOSED_COMPLETE,
      ConsultationStatus.TIMED_OUT,
      ConsultationStatus.REOPENED,
      ConsultationStatus.CLOSED,
    ])('%s is not recordable', async (status) => {
      consultationRepository.findByUniqueKey.mockResolvedValue(row({ status }));
      expect((await open({})).recordable).toBe(false);
    });

    it.each([ConsultationStatus.OPEN, ConsultationStatus.PENDING_REVIEW, ConsultationStatus.CLOSED_INCOMPLETE, ConsultationStatus.RECORDING])(
      '%s is recordable',
      async (status) => {
        consultationRepository.findByUniqueKey.mockResolvedValue(row({ status }));
        expect((await open({})).recordable).toBe(true);
      },
    );

    it('parent === the match → a NEW child: the caller is explicitly following that row up', async () => {
      const morning = row({ status: ConsultationStatus.SIGNED });
      consultationRepository.findByUniqueKey.mockResolvedValue(morning);
      consultationRepository.findById.mockResolvedValue(morning);

      const result = await open({ parentConsultationId: morning.id });

      expect(consultationRepository.create).toHaveBeenCalledTimes(1);
      expect(created().parentConsultationId).toBe(morning.id);
      expect(result.isNew).toBe(true);
      expect(result.visitType).toBe('revisit');
    });

    it('a parent that is neither the match nor its parent → a NEW child', async () => {
      const match = row({ parentConsultationId: 'c-root' });
      const unrelated = row({ id: 'c-unrelated' });
      consultationRepository.findByUniqueKey.mockResolvedValue(match);
      consultationRepository.findById.mockResolvedValue(unrelated);

      const result = await open({ parentConsultationId: 'c-unrelated' });

      expect(result.isNew).toBe(true);
      expect(created().parentConsultationId).toBe('c-unrelated');
    });

    it("a parent equal to the MATCH's own parent → the match (a retry of the follow-up open)", async () => {
      const followUp = row({ parentConsultationId: 'c-root' });
      consultationRepository.findByUniqueKey.mockResolvedValue(followUp);
      consultationRepository.findById.mockResolvedValue(row({ id: 'c-root' }));

      const result = await open({ parentConsultationId: 'c-root' });

      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(followUp.id);
    });
  });

  // ── 4. Parent patient ─────────────────────────────────────────────────────
  it('a parent of ANOTHER patient is 400 PARENT_PATIENT_MISMATCH, before anything is read or written', async () => {
    consultationRepository.findById.mockResolvedValue(row({ id: 'c-foreign-patient', patientId: 'patient-9' }));

    const error = await open({ parentConsultationId: 'c-foreign-patient' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'PARENT_PATIENT_MISMATCH' });
    expect(consultationRepository.findByUniqueKey).not.toHaveBeenCalled();
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  // ── 6. Consent + the tenant's day ─────────────────────────────────────────
  // DEVIATION from the brief (item 7), on purpose: `ensureConsultationConsent` GRANTS every purpose
  // without an active grant, so calling it on a re-open would UNDO a revocation recorded since the
  // first open. D-6's intent ("a revocation since the morning is honoured") is met by NOT calling it.
  it('a RE-open does not re-grant consent — a revocation since the first open is honoured', async () => {
    consultationRepository.findByUniqueKey.mockResolvedValue(row());

    await open({});

    expect(consentGrantService.ensureConsultationConsent).not.toHaveBeenCalled();
  });

  it('a NEW encounter (new ref on a day that already has a visit) records consent, as every create does', async () => {
    consultationRepository.findByUniqueKey.mockResolvedValue(row());

    await open({ metadata: { externalRef: 'EVT-9' } });

    expect(consentGrantService.ensureConsultationConsent).toHaveBeenCalledWith(PATIENT);
  });

  it('the default appointmentDate is TODAY in the tenant time zone (Asia/Kolkata at 19:00Z → the next day)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T19:00:00Z'));
    timeZone = 'Asia/Kolkata';

    const result = await buildService().getOrCreate({ patientId: PATIENT } as OpenConsultationRequest, DOCTOR);

    expect(tenantSettings.resolve).toHaveBeenCalledWith(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, TENANT);
    expect(consultationRepository.findByUniqueKey).toHaveBeenCalledWith(TENANT, PATIENT, new Date('2026-09-30'), DOCTOR);
    expect(result.appointmentDate).toBe('2026-09-30');
  });

  it('the default day stays the UTC day when the tenant has no time zone (and when settings are unwired)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T19:00:00Z'));

    const result = await buildService().getOrCreate({ patientId: PATIENT } as OpenConsultationRequest, DOCTOR);
    expect(result.appointmentDate).toBe('2026-09-29');

    tenantSettings = undefined;
    consultationRepository.create.mockClear();
    const unwired = await buildService().getOrCreate({ patientId: PATIENT } as OpenConsultationRequest, DOCTOR);
    expect(unwired.appointmentDate).toBe('2026-09-29');
  });

  it('a caller-supplied appointmentDate still wins over the tenant day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T19:00:00Z'));
    timeZone = 'Asia/Kolkata';

    await open({ appointmentDate: '2026-09-28' });

    expect(consultationRepository.findByUniqueKey).toHaveBeenCalledWith(TENANT, PATIENT, new Date('2026-09-28'), DOCTOR);
  });

  // ── 5. Recording on a terminal row ────────────────────────────────────────
  describe('startRecording', () => {
    it.each([ConsultationStatus.SIGNED, ConsultationStatus.REOPENED])(
      'on %s with the kill-switch OFF → 409 CONSULTATION_NOT_RECORDABLE, nothing written',
      async (status) => {
        consultationRepository.findWithRelations.mockResolvedValue(row({ status }));

        const error = await buildService()
          .startRecording('c-1')
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CONSULTATION_NOT_RECORDABLE' });
        expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      },
    );

    it('on OPEN with the kill-switch OFF → still allowed (the one legacy bypass)', async () => {
      consultationRepository.findWithRelations.mockResolvedValue(row({ status: ConsultationStatus.OPEN }));

      const result = await buildService().startRecording('c-1');

      expect(result.status).toBe(ConsultationStatus.RECORDING);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it('on OPEN with the kill-switch ON → 409 CONSULTATION_TRANSITION_ILLEGAL (the bare matrix refusal now carries a code)', async () => {
      requirePrimed = true;
      consultationRepository.findWithRelations.mockResolvedValue(row({ status: ConsultationStatus.OPEN }));

      const error = await buildService()
        .startRecording('c-1')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CONSULTATION_TRANSITION_ILLEGAL' });
    });
  });
});

describe('consultation.appointmentDay.timeZone descriptor', () => {
  const descriptor = CONSULTATION_APPOINTMENT_DAY_SETTINGS.find((entry) => entry.key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY)!;

  it('is registered, global-kv, tenant-scoped, open-to-default UTC', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY)).toBeDefined();
    expect(descriptor).toMatchObject({ tier: 'global-kv', maxScope: 'tenant', failMode: 'open-to-default', default: 'UTC' });
  });

  it('accepts IANA zones and refuses anything else', () => {
    expect(descriptor.validate?.('Asia/Kolkata')).toBeUndefined();
    expect(descriptor.validate?.('UTC')).toBeUndefined();
    expect(descriptor.validate?.('Mars/Olympus')).toEqual(expect.any(String));
    expect(descriptor.validate?.('')).toEqual(expect.any(String));
    expect(descriptor.validate?.(530)).toEqual(expect.any(String));
  });
});
