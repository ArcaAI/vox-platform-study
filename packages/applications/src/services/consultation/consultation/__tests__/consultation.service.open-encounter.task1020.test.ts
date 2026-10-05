/**
 * TASK-1020 — `open` is the only entry, and a same-day return visit must never be lost —
 * re-pinned on the TASK-1045 episode model (D-3: a consultation is an EPISODE of encounters; the
 * TASK-1020 per-visit model and its OD-1/OD-3/OD-4 rules are reversed — see the TASK-1020 README
 * Change History). The new rules themselves are pinned in
 * `consultation.service.open-episode.task1045.test.ts`; this file keeps the TASK-1020 guarantees
 * that survived, restated on the new key:
 *
 *  1. THE ENCOUNTER KEY. An `externalRef` (the EMR event id) names an ENCOUNTER: the same ref is the
 *     same consultation (retries and reconnects are safe) — closed or not, `recordable` says which —
 *     and a ref already used for another patient is 409 `EXTERNAL_REF_CONFLICT`. The ref is written
 *     to the column on CREATE (and still to the metadata marker, for readers that predate it).
 *  2. THE OPEN KEY. Without a ref, the non-closed consultation of (tenant, clinician, patient,
 *     department) is returned; with none, a NEW consultation is chained to the latest CLOSED one of
 *     the key (never an implicit reopen). An explicit parent wins. A lost unique-index race answers
 *     with the winner.
 *  3. THE PARENT IS THE SAME PATIENT (D-5): 400 `PARENT_PATIENT_MISMATCH`.
 *  4. A RE-OPEN DOES NOT RE-GRANT CONSENT (D-6's intent: a revocation is honoured — the grant happens
 *     when a NEW encounter is created), and the day stamped on a new consultation is the TENANT's
 *     day (BP-5/OD-8).
 *
 * Removed (reversed by D-3): the same-day DERIVED parent of any clinician (OD-4 — chaining is to the
 * latest closed consultation of the key), forking a child when the caller names a parent (OD-3 — a
 * follow-up is an encounter appended to the open consultation), the 12-state recordability table,
 * and `startRecording`'s kill-switch cases (PRIMED is gone; recordability is the lifecycle start's,
 * pinned in `consultation.service.recording.test.ts`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { encounterServiceDouble, lifecycleDouble, type EncounterServiceDouble } from './consultation-service.fixture';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { readExternalRef } from '../open-markers';
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  CONSULTATION_APPOINTMENT_DAY_SETTINGS,
} from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';
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

const OPEN_KEY = { tenantId: TENANT, doctorId: DOCTOR, patientId: PATIENT, departmentId: null };
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('ConsultationService — TASK-1020 open guarantees on the episode model (TASK-1045 D-3)', () => {
  let consultationRepository: any;
  let encounters: EncounterServiceDouble;
  let consentGrantService: any;
  let tenantSettings: any;
  let emit: ReturnType<typeof vi.fn>;
  let timeZone: unknown;

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
      encounters as any,
      lifecycleDouble() as any,
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
    consultationRepository = {
      findOpenByKey: vi.fn().mockResolvedValue(null),
      findLatestClosedByKey: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: ConsultationEntity) => entity),
      updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => entity),
    };
    encounters = encounterServiceDouble(consultationRepository);
    consentGrantService = { ensureConsultationConsent: vi.fn().mockResolvedValue(undefined) };
    tenantSettings = {
      resolve: vi.fn((key: string) => ({
        key,
        value: key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY ? (timeZone ?? 'UTC') : undefined,
        source: 'code-default',
      })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. The encounter key ──────────────────────────────────────────────────
  describe('with an externalRef', () => {
    it('same ref → the same consultation (isNew false), nothing created, and the open key is not consulted', async () => {
      const morning = row({ externalRef: 'EVT-1', metadata: { externalRef: 'EVT-1' } });
      encounters.matchExternalRef.mockResolvedValue({ own: { consultationId: morning.id, seq: 1, externalRef: 'EVT-1' }, conflict: false });
      consultationRepository.findWithRelations.mockResolvedValue(morning);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(encounters.matchExternalRef).toHaveBeenCalledWith(TENANT, 'EVT-1', { patientId: PATIENT, doctorId: DOCTOR });
      expect(consultationRepository.findOpenByKey).not.toHaveBeenCalled();
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(morning.id);
      expect(result.isNew).toBe(false);
      expect(result.externalRef).toBe('EVT-1');
      expect(result.recordable).toBe(true);
    });

    it('the same ref on a CLOSED consultation is returned as it is — recordable:false, never reopened or forked', async () => {
      const closed = row({ externalRef: 'EVT-1', status: ConsultationStatus.CLOSED_COMPLETE });
      encounters.matchExternalRef.mockResolvedValue({ own: { consultationId: closed.id, seq: 1, externalRef: 'EVT-1' }, conflict: false });
      consultationRepository.findWithRelations.mockResolvedValue(closed);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(result.id).toBe(closed.id);
      expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
      expect(result.recordable).toBe(false);
    });

    it('a new ref with no open consultation → a NEW consultation whose first encounter carries the ref (column + marker)', async () => {
      const result = await open({ metadata: { externalRef: 'EVT-2', visitType: 'revisit' } });

      expect(consultationRepository.create).toHaveBeenCalledTimes(1);
      expect(created().externalRef).toBe('EVT-2');
      // The marker is still written, for every reader that predates the column.
      expect(readExternalRef(created().metadata)).toBe('EVT-2');
      expect(encounters.createConsultation).toHaveBeenCalledWith(created(), expect.objectContaining({ externalRef: 'EVT-2', visitType: 'revisit' }));
      expect(result.isNew).toBe(true);
      expect(result.status).toBe(ConsultationStatus.OPEN);
      expect(result.recordable).toBe(true);
    });

    it('a racing open that loses the unique index returns the winner (isNew false), not a 500', async () => {
      const winner = row({ externalRef: 'EVT-RACE', metadata: { externalRef: 'EVT-RACE' } });
      encounters.matchExternalRef
        .mockResolvedValueOnce({ own: null, conflict: false })
        .mockResolvedValueOnce({ own: { consultationId: winner.id, seq: 1, externalRef: 'EVT-RACE' }, conflict: false });
      consultationRepository.findWithRelations.mockResolvedValue(winner);
      consultationRepository.create.mockRejectedValueOnce(uniqueViolation());

      const result = await open({ metadata: { externalRef: 'EVT-RACE' } });

      expect(result.id).toBe(winner.id);
      expect(result.isNew).toBe(false);
    });

    it('a ref already used for ANOTHER patient is 409 EXTERNAL_REF_CONFLICT and nothing is written', async () => {
      encounters.matchExternalRef.mockResolvedValue({ own: null, conflict: true });

      const error = await open({ metadata: { externalRef: 'EVT-1' } }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'EXTERNAL_REF_CONFLICT' });
      expect(consultationRepository.create).not.toHaveBeenCalled();
    });
  });

  // ── 2. The open key ───────────────────────────────────────────────────────
  describe('without an externalRef', () => {
    it.each([
      [ConsultationStatus.OPEN, true],
      [ConsultationStatus.RECORDING, true],
      [ConsultationStatus.PAUSED, true],
      [ConsultationStatus.STOPPED, true],
      [ConsultationStatus.APPROVED, false],
    ])('a non-closed %s match is returned as it is (recordable: %s), never forked', async (status, recordable) => {
      const match = row({ status });
      consultationRepository.findOpenByKey.mockResolvedValue(match);

      const result = await open({});

      expect(consultationRepository.findOpenByKey).toHaveBeenCalledWith(OPEN_KEY);
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(match.id);
      expect(result.isNew).toBe(false);
      expect(result.recordable).toBe(recordable);
      expect(result.externalRef).toBeNull();
    });

    it('no non-closed match → a NEW consultation chained to the latest CLOSED one of the key (never an implicit reopen)', async () => {
      const closed = row({ status: ConsultationStatus.CLOSED_INCOMPLETE });
      consultationRepository.findLatestClosedByKey.mockResolvedValue(closed);

      const result = await open({});

      expect(consultationRepository.findLatestClosedByKey).toHaveBeenCalledWith(OPEN_KEY);
      expect(created().parentConsultationId).toBe(closed.id);
      expect(result.isNew).toBe(true);
      expect(result.parentConsultationId).toBe(closed.id);
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('an explicit parent wins over the latest closed match', async () => {
      const explicitParent = row({ id: 'c-explicit' });
      consultationRepository.findById.mockResolvedValue(explicitParent);
      consultationRepository.findLatestClosedByKey.mockResolvedValue(row({ status: ConsultationStatus.CLOSED_COMPLETE }));

      await open({ parentConsultationId: 'c-explicit' });

      expect(created().parentConsultationId).toBe('c-explicit');
      expect(consultationRepository.findLatestClosedByKey).not.toHaveBeenCalled();
    });

    it('a racing open that loses the open-key unique index answers with the winner', async () => {
      const winner = row();
      consultationRepository.findOpenByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      consultationRepository.create.mockRejectedValueOnce(uniqueViolation());

      const result = await open({});

      expect(result.id).toBe(winner.id);
      expect(result.isNew).toBe(false);
    });

    it('a unique violation that persists after the one re-match is rethrown untouched', async () => {
      const failure = uniqueViolation();
      consultationRepository.create.mockRejectedValue(failure);

      await expect(open({})).rejects.toBe(failure);
      expect(consultationRepository.findOpenByKey).toHaveBeenCalledTimes(2);
    });
  });

  // ── 3. Parent patient ─────────────────────────────────────────────────────
  it('a parent of ANOTHER patient is 400 PARENT_PATIENT_MISMATCH, before anything is read or written', async () => {
    consultationRepository.findById.mockResolvedValue(row({ id: 'c-foreign-patient', patientId: 'patient-9' }));

    const error = await open({ parentConsultationId: 'c-foreign-patient' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'PARENT_PATIENT_MISMATCH' });
    expect(consultationRepository.findOpenByKey).not.toHaveBeenCalled();
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  // ── 4. Consent + the tenant's day ─────────────────────────────────────────
  // `ensureConsultationConsent` GRANTS every purpose without an active grant, so calling it on a
  // re-open would UNDO a revocation recorded since the first open. D-6's intent ("a revocation since
  // the morning is honoured") is met by NOT calling it.
  it('a RE-open does not re-grant consent — a revocation since the first open is honoured', async () => {
    consultationRepository.findOpenByKey.mockResolvedValue(row());

    await open({});

    expect(consentGrantService.ensureConsultationConsent).not.toHaveBeenCalled();
  });

  it('a NEW encounter (a new ref on an open consultation) records consent, as every new visit does', async () => {
    const morning = row();
    consultationRepository.findOpenByKey.mockResolvedValue(morning);

    await open({ metadata: { externalRef: 'EVT-9' } });

    expect(encounters.appendEncounter).toHaveBeenCalledWith(morning, expect.objectContaining({ externalRef: 'EVT-9' }));
    expect(consentGrantService.ensureConsultationConsent).toHaveBeenCalledWith(PATIENT);
  });

  it('the default appointmentDate is TODAY in the tenant time zone (Asia/Kolkata at 19:00Z → the next day)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T19:00:00Z'));
    timeZone = 'Asia/Kolkata';

    const result = await buildService().getOrCreate({ patientId: PATIENT } as OpenConsultationRequest, DOCTOR);

    expect(tenantSettings.resolve).toHaveBeenCalledWith(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, TENANT);
    // The day is stamped on the new consultation; it is not part of the open key.
    expect(consultationRepository.findOpenByKey).toHaveBeenCalledWith(OPEN_KEY);
    expect(created().appointmentDate).toEqual(new Date('2026-09-30'));
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

    expect(created().appointmentDate).toEqual(new Date('2026-09-28'));
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
