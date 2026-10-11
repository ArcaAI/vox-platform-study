/**
 * TASK-1045 D-3 — a consultation is an EPISODE with encounters, and `open` resolves the encounter.
 *
 * Pinned here (P-AB §1.3 / §1.4):
 *  1. `externalRef` selects the ENCOUNTER: a hit on (tenant, ref) for the same patient + clinician is
 *     idempotent and returns its consultation even when closed (`recordable: false`); the same ref
 *     for another patient is 409 `EXTERNAL_REF_CONFLICT`.
 *  2. Otherwise the non-closed consultation of the open key (tenant, doctor, patient, department —
 *     null-safe) is returned; the appointment date is no longer part of the key.
 *  3. An encounter is APPENDED on a new ref, or with no ref when the visit is a `revisit` and the
 *     current encounter has ended — only from OPEN / STOPPED: RECORDING / PAUSED → 409
 *     `ENCOUNTER_CAPTURE_ACTIVE`, APPROVED → 409 `CONSULTATION_APPROVED`.
 *  4. No non-closed match → a NEW consultation chained to the latest closed match of the key.
 *  5. A race on the open-key unique index returns the winner.
 *  6. The response carries the lifecycle fields; the lifecycle commands delegate to the lifecycle
 *     service.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  ConsultationClosedReason,
  ConsultationEncounterEntity,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ResourceStatusType,
} from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { ConsultationEncounterService } from '../../encounter/consultation-encounter.service';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY } from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { CONSULTATION_AUTO_CLOSE_SETTING_KEY, CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY } from '../../encounter/lifecycle-view';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';
const PATIENT = 'patient-1';
const OTHER_PATIENT = 'patient-2';
const DEPARTMENT = 'dept-1';

let idSeq = 0;
function consultation(overrides: Partial<Record<string, unknown>> = {}): ConsultationEntity {
  idSeq += 1;
  return new ConsultationEntity({
    id: `c-${idSeq}`,
    tenantId: TENANT,
    patientId: PATIENT,
    doctorId: DOCTOR,
    appointmentDate: new Date('2026-10-01'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    externalRef: null,
    status: ConsultationStatus.OPEN,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: 1,
    lastActivityAt: new Date('2026-10-05T08:00:00Z'),
    degradedReasons: [],
    createdAt: new Date('2026-10-01T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
    createdBy: DOCTOR,
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    version: 3,
    ...overrides,
  } as any);
}

function encounter(c: ConsultationEntity, overrides: Partial<Record<string, unknown>> = {}): ConsultationEncounterEntity {
  return new ConsultationEncounterEntity({
    id: `e-${c.id}-${(overrides.seq as number) ?? 1}`,
    tenantId: TENANT,
    consultationId: c.id,
    seq: 1,
    visitType: 'new-visit',
    externalRef: null,
    startedAt: new Date('2026-10-01T08:00:00Z'),
    endedAt: null,
    recordingStartMs: null,
    recordingEndMs: null,
    createdAt: new Date('2026-10-01T08:00:00Z'),
    updatedAt: new Date('2026-10-01T08:00:00Z'),
    Consultation: c,
    ...overrides,
  } as any);
}

describe('ConsultationService — TASK-1045 open resolves the encounter of an episode', () => {
  let consultationRepository: any;
  let encounterRepository: any;
  let approvalRepository: any;
  let lifecycle: any;
  let tenantSettings: any;
  let consentGrantService: any;
  let tx: any;
  let emit: ReturnType<typeof vi.fn>;
  let encountersByConsultation: Map<string, ConsultationEncounterEntity[]>;
  let rowsById: Map<string, ConsultationEntity>;
  let allowClosedComplete: boolean;
  let autoClose: unknown;
  let timeZone: string;

  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: DOCTOR, tenantId: TENANT };
      return null;
    }),
    set: vi.fn(),
  };

  const buildEncounterService = () =>
    new ConsultationEncounterService(
      encounterRepository,
      consultationRepository,
      approvalRepository,
      { baseClient: { $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) } } as any,
      { emit } as any,
      cls as any,
      tenantSettings,
    );

  const buildService = () =>
    new ConsultationService(
      consultationRepository,
      {} as any, // departmentRepository
      { findFirst: vi.fn().mockResolvedValue({ id: 'ura-1' }) } as any, // userRoleAssignmentRepository
      { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1' }) } as any, // userDepartmentRepository
      { findFirst: vi.fn().mockResolvedValue(null) } as any, // userRepository
      { emit } as any,
      cls as any,
      buildEncounterService(),
      lifecycle,
      undefined, // entitlements
      tenantSettings,
      undefined, // workflowDispatchService
      consentGrantService,
    );

  const open = (request: Partial<OpenConsultationRequest>) =>
    buildService().getOrCreate({ patientId: PATIENT, ...request } as OpenConsultationRequest, DOCTOR);

  const seed = (c: ConsultationEntity, encounters: ConsultationEncounterEntity[] = [encounter(c)]) => {
    rowsById.set(c.id, c);
    encountersByConsultation.set(c.id, encounters);
    return c;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    idSeq = 0;
    emit = vi.fn();
    tx = { tx: true };
    encountersByConsultation = new Map();
    rowsById = new Map();
    allowClosedComplete = false;
    autoClose = { mode: 'idle', idleMinutes: 720, dailyAt: null };
    timeZone = 'UTC';

    consultationRepository = {
      findOpenByKey: vi.fn().mockResolvedValue(null),
      findLatestClosedByKey: vi.fn().mockResolvedValue(null),
      findByUniqueKey: vi.fn(),
      findById: vi.fn(async (id: string) => rowsById.get(id) ?? null),
      findWithRelations: vi.fn(async (id: string) => rowsById.get(id) ?? null),
      create: vi.fn(async (entity: ConsultationEntity) => {
        rowsById.set(entity.id, entity);
        return entity;
      }),
      updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => entity),
    };
    encounterRepository = {
      findByExternalRef: vi.fn().mockResolvedValue([]),
      findByConsultation: vi.fn(async (id: string) => encountersByConsultation.get(id) ?? []),
      findBySeq: vi.fn(async (id: string, s: number) => (encountersByConsultation.get(id) ?? []).find((e) => e.seq === s) ?? null),
      create: vi.fn(async (entity: ConsultationEncounterEntity) => {
        encountersByConsultation.set(entity.consultationId, [...(encountersByConsultation.get(entity.consultationId) ?? []), entity]);
        return entity;
      }),
      endEncounter: vi.fn().mockResolvedValue(true),
    };
    approvalRepository = { findLatestByConsultation: vi.fn().mockResolvedValue(null) };
    lifecycle = {
      start: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      approve: vi.fn(),
      close: vi.fn(),
      reopen: vi.fn(),
    };
    consentGrantService = { ensureConsultationConsent: vi.fn().mockResolvedValue(undefined) };
    tenantSettings = {
      resolve: vi.fn((key: string) => {
        if (key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY) return { key, value: timeZone };
        if (key === CONSULTATION_AUTO_CLOSE_SETTING_KEY) return { key, value: autoClose };
        if (key === CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY) return { key, value: allowClosedComplete };
        throw new Error(`Unknown setting '${key}'.`);
      }),
      resolvePlatform: vi.fn(() => ({ value: undefined })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. externalRef selects the encounter ──────────────────────────────────
  describe('with an externalRef', () => {
    it('a hit for the same patient + clinician is idempotent: its consultation, nothing written, the open key not consulted', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED }));
      const e = encounter(c, { externalRef: 'EVT-1' });
      encountersByConsultation.set(c.id, [e]);
      encounterRepository.findByExternalRef.mockResolvedValue([e]);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(encounterRepository.findByExternalRef).toHaveBeenCalledWith(TENANT, 'EVT-1');
      expect(consultationRepository.findOpenByKey).not.toHaveBeenCalled();
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(encounterRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(c.id);
      expect(result.isNew).toBe(false);
      expect(result.encounterAppended).toBe(false);
      expect(result.externalRef).toBe('EVT-1');
      expect(result.recordable).toBe(true);
    });

    it('a hit on a CLOSED consultation is returned as it is, with recordable false', async () => {
      const c = seed(
        consultation({
          status: ConsultationStatus.CLOSED_COMPLETE,
          closedReason: ConsultationClosedReason.APPROVED,
          closedAt: new Date('2026-10-02T10:00:00Z'),
          approvedAt: new Date('2026-10-02T09:00:00Z'),
        }),
      );
      const e = encounter(c, { externalRef: 'EVT-1', endedAt: new Date('2026-10-02T09:00:00Z') });
      encountersByConsultation.set(c.id, [e]);
      encounterRepository.findByExternalRef.mockResolvedValue([e]);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(result.id).toBe(c.id);
      expect(result.status).toBe(ConsultationStatus.CLOSED_COMPLETE);
      expect(result.recordable).toBe(false);
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('the same ref for another patient is 409 EXTERNAL_REF_CONFLICT, nothing written', async () => {
      const foreign = consultation({ patientId: OTHER_PATIENT });
      encounterRepository.findByExternalRef.mockResolvedValue([encounter(foreign, { externalRef: 'EVT-1' })]);

      const error = await open({ metadata: { externalRef: 'EVT-1' } }).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'EXTERNAL_REF_CONFLICT' });
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(encounterRepository.create).not.toHaveBeenCalled();
    });

    it('a NEW ref on the open consultation of the key appends an encounter (ends the previous one, bumps the seq, OPEN)', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED, departmentId: null }));
      encountersByConsultation.set(c.id, [encounter(c, { externalRef: 'EVT-1' })]);
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({ metadata: { externalRef: 'EVT-2' } });

      expect(consultationRepository.findOpenByKey).toHaveBeenCalledWith({
        tenantId: TENANT,
        doctorId: DOCTOR,
        patientId: PATIENT,
        departmentId: null,
      });
      expect(consultationRepository.create).not.toHaveBeenCalled();
      // The consultation write is CAS-guarded on the version it was read at, inside the transaction.
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(c.id, expect.any(ConsultationEntity), 3, tx);
      expect(encounterRepository.endEncounter).toHaveBeenCalledWith(c.id, 1, expect.anything(), tx);
      const appended: ConsultationEncounterEntity = encounterRepository.create.mock.calls[0][0];
      expect(encounterRepository.create.mock.calls[0][1]).toBe(tx);
      expect(appended.seq).toBe(2);
      expect(appended.externalRef).toBe('EVT-2');
      expect(appended.visitType).toBe('revisit');
      expect(appended.tenantId).toBe(TENANT);
      expect(result.id).toBe(c.id);
      expect(result.status).toBe(ConsultationStatus.OPEN);
      expect(result.currentEncounterSeq).toBe(2);
      expect(result.encounterAppended).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.externalRef).toBe('EVT-2');
      expect(result.encounters.map((x) => x.seq)).toEqual([1, 2]);
      // Opening a new encounter is the consent event, as creating one was.
      expect(consentGrantService.ensureConsultationConsent).toHaveBeenCalledWith(PATIENT);
    });
  });

  // ── 2. the open key ───────────────────────────────────────────────────────
  describe('without an externalRef', () => {
    it('returns the non-closed consultation of the key (department null-safe); the appointment date is not part of the key', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED, departmentId: DEPARTMENT, appointmentDate: new Date('2026-09-01') }));
      consultationRepository.findOpenByKey.mockResolvedValue(c);
      const departmentRepository = {
        findFirst: vi.fn().mockResolvedValue({ id: DEPARTMENT, tenantId: TENANT }),
        findById: vi.fn().mockResolvedValue({ id: DEPARTMENT, tenantId: TENANT }),
      };
      const service = buildService();
      (service as any).departmentRepository = departmentRepository;

      const result = await service.getOrCreate({ patientId: PATIENT, departmentId: DEPARTMENT, appointmentDate: '2026-10-05' } as any, DOCTOR);

      expect(consultationRepository.findOpenByKey).toHaveBeenCalledWith({
        tenantId: TENANT,
        doctorId: DOCTOR,
        patientId: PATIENT,
        departmentId: DEPARTMENT,
      });
      expect(consultationRepository.findByUniqueKey).not.toHaveBeenCalled();
      expect(result.id).toBe(c.id);
      expect(result.isNew).toBe(false);
      expect(result.encounterAppended).toBe(false);
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(encounterRepository.create).not.toHaveBeenCalled();
    });

    it('a revisit whose current encounter has ENDED appends an encounter', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED }), []);
      encountersByConsultation.set(c.id, [encounter(c, { endedAt: new Date('2026-10-05T09:00:00Z') })]);
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({ metadata: { visitType: 'revisit' } });

      expect(result.encounterAppended).toBe(true);
      expect(result.currentEncounterSeq).toBe(2);
      const appended: ConsultationEncounterEntity = encounterRepository.create.mock.calls[0][0];
      expect(appended.seq).toBe(2);
      expect(appended.externalRef).toBeNull();
      expect(appended.visitType).toBe('revisit');
    });

    it('a revisit whose current encounter is still open does NOT append (a retry of the same visit)', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED }));
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({ metadata: { visitType: 'revisit' } });

      expect(result.encounterAppended).toBe(false);
      expect(encounterRepository.create).not.toHaveBeenCalled();
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('a new-visit with an ended encounter does NOT append', async () => {
      const c = seed(consultation({ status: ConsultationStatus.STOPPED }), []);
      encountersByConsultation.set(c.id, [encounter(c, { endedAt: new Date('2026-10-05T09:00:00Z') })]);
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({});

      expect(result.encounterAppended).toBe(false);
      expect(encounterRepository.create).not.toHaveBeenCalled();
    });
  });

  // ── 3. append refusals ────────────────────────────────────────────────────
  describe('append refusals', () => {
    it.each([
      [ConsultationStatus.RECORDING, 'ENCOUNTER_CAPTURE_ACTIVE'],
      [ConsultationStatus.PAUSED, 'ENCOUNTER_CAPTURE_ACTIVE'],
      // BUG-009 — APPROVED no longer refuses a new ref: a signed visit cannot take another
      // encounter, so the next visit becomes its own consultation chained to it (see below).
    ])('%s → 409 %s, nothing written', async (status, code) => {
      const c = seed(consultation({ status }));
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const error = await open({ metadata: { externalRef: 'EVT-NEW' } }).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code });
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(encounterRepository.create).not.toHaveBeenCalled();
      expect(encounterRepository.endEncounter).not.toHaveBeenCalled();
    });

    it('APPROVED without a new encounter is simply returned (no refusal)', async () => {
      const c = seed(consultation({ status: ConsultationStatus.APPROVED, approvedAt: new Date('2026-10-05T09:00:00Z') }));
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({});

      expect(result.id).toBe(c.id);
      expect(result.recordable).toBe(false);
    });
  });

  // ── BUG-009 — a revisit that names its previous visit gets its OWN consultation ─────────
  //
  // Owner decisions 2026-10-10/11: naming a parent always creates a new linked consultation
  // (OD-1), and the parent is CLOSED first so the open-key unique index has room for the child
  // (OD-4). Before this, the open-key match won: an APPROVED parent answered 409
  // CONSULTATION_APPROVED (console, API and ALaaS all confirmed live) and a STOPPED one got a
  // second encounter appended, so the revisit never had a consultation of its own.
  describe('BUG-009 — a named previous visit is closed and the revisit is a new consultation', () => {
    const openNaming = (parentId: string, extra: Partial<OpenConsultationRequest> = {}) => {
      const service = buildService();
      (service as any).consultationRepository.findFirst = vi.fn(async () => rowsById.get(parentId) ?? null);
      return service.getOrCreate({ patientId: PATIENT, parentConsultationId: parentId, ...extra } as OpenConsultationRequest, DOCTOR);
    };

    it.each([
      [ConsultationStatus.APPROVED, { approvedAt: new Date('2026-10-05T09:00:00Z') }],
      [ConsultationStatus.STOPPED, {}],
    ])('a %s open match named as the parent is closed, then a NEW chained consultation is created', async (status, extra) => {
      const parent = seed(consultation({ status, ...extra }), []);
      encountersByConsultation.set(parent.id, [encounter(parent, { endedAt: new Date('2026-10-05T09:00:00Z') })]);
      consultationRepository.findOpenByKey.mockResolvedValue(parent);

      const result = await openNaming(parent.id, { metadata: { visitType: 'revisit' } } as any);

      expect(lifecycle.close).toHaveBeenCalledWith(parent.id, { clinicianUserId: DOCTOR });
      const created: ConsultationEntity = consultationRepository.create.mock.calls[0][0];
      expect(created.id).not.toBe(parent.id);
      expect(created.parentConsultationId).toBe(parent.id);
      expect(result.id).toBe(created.id);
      expect(result.isNew).toBe(true);
      expect(result.encounterAppended).toBe(false);
      // Nothing is appended to the parent: its note and signature stay as they were.
      expect(encounterRepository.create.mock.calls.every((call: any[]) => call[0].consultationId === created.id)).toBe(true);
    });

    it('an APPROVED open match with a NEW externalRef (the ALaaS revisit) is closed and chained, not 409', async () => {
      const parent = seed(consultation({ status: ConsultationStatus.APPROVED, approvedAt: new Date('2026-10-05T09:00:00Z') }));
      consultationRepository.findOpenByKey.mockResolvedValue(parent);

      const result = await open({ metadata: { externalRef: 'EVT-REVISIT' } });

      expect(lifecycle.close).toHaveBeenCalledWith(parent.id, { clinicianUserId: DOCTOR });
      const created: ConsultationEntity = consultationRepository.create.mock.calls[0][0];
      expect(created.parentConsultationId).toBe(parent.id);
      expect(result.id).toBe(created.id);
      const first: ConsultationEncounterEntity = encounterRepository.create.mock.calls[0][0];
      expect(first.externalRef).toBe('EVT-REVISIT');
    });

    it('a parent still capturing is NOT closed out from under the clinician (RECORDING → returned as before)', async () => {
      const parent = seed(consultation({ status: ConsultationStatus.RECORDING }));
      consultationRepository.findOpenByKey.mockResolvedValue(parent);

      const result = await openNaming(parent.id);

      expect(lifecycle.close).not.toHaveBeenCalled();
      expect(consultationRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(parent.id);
    });

    it('a plain re-open of an APPROVED visit (no parent named, no new ref) still returns it untouched', async () => {
      const c = seed(consultation({ status: ConsultationStatus.APPROVED, approvedAt: new Date('2026-10-05T09:00:00Z') }));
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({});

      expect(lifecycle.close).not.toHaveBeenCalled();
      expect(result.id).toBe(c.id);
    });
  });

  // ── 4. create ─────────────────────────────────────────────────────────────
  describe('no non-closed match', () => {
    it('creates a new consultation with encounter 1 in one transaction (new-visit when nothing is closed)', async () => {
      const result = await open({ metadata: { externalRef: 'EVT-9' } });

      const created: ConsultationEntity = consultationRepository.create.mock.calls[0][0];
      expect(consultationRepository.create.mock.calls[0][1]).toBe(tx);
      expect(created.status).toBe(ConsultationStatus.OPEN);
      expect(created.currentEncounterSeq).toBe(1);
      expect(created.parentConsultationId ?? null).toBeNull();
      const first: ConsultationEncounterEntity = encounterRepository.create.mock.calls[0][0];
      expect(encounterRepository.create.mock.calls[0][1]).toBe(tx);
      expect(first.seq).toBe(1);
      expect(first.consultationId).toBe(created.id);
      expect(first.externalRef).toBe('EVT-9');
      expect(first.visitType).toBe('new-visit');
      expect(result.isNew).toBe(true);
      expect(result.encounterAppended).toBe(false);
      expect(result.encounters).toHaveLength(1);
      expect(consentGrantService.ensureConsultationConsent).toHaveBeenCalledWith(PATIENT);
    });

    it('chains the new consultation to the latest CLOSED match of the key (late return after auto-close)', async () => {
      const closed = seed(consultation({ status: ConsultationStatus.CLOSED_INCOMPLETE, closedReason: ConsultationClosedReason.AUTO }));
      consultationRepository.findLatestClosedByKey.mockResolvedValue(closed);

      const result = await open({});

      expect(consultationRepository.findLatestClosedByKey).toHaveBeenCalledWith({
        tenantId: TENANT,
        doctorId: DOCTOR,
        patientId: PATIENT,
        departmentId: null,
      });
      const created: ConsultationEntity = consultationRepository.create.mock.calls[0][0];
      expect(created.parentConsultationId).toBe(closed.id);
      expect(created.id).not.toBe(closed.id);
      expect(result.parentConsultationId).toBe(closed.id);
      expect(result.visitType).toBe('revisit');
      const first: ConsultationEncounterEntity = encounterRepository.create.mock.calls[0][0];
      expect(first.visitType).toBe('revisit');
    });

    it('a caller-named parent wins over the closed match', async () => {
      const named = seed(consultation({ id: 'c-named', status: ConsultationStatus.CLOSED_COMPLETE }));
      consultationRepository.findLatestClosedByKey.mockResolvedValue(seed(consultation({ status: ConsultationStatus.CLOSED_INCOMPLETE })));
      const service = buildService();
      (service as any).consultationRepository.findFirst = vi.fn().mockResolvedValue(named);

      await service.getOrCreate({ patientId: PATIENT, parentConsultationId: named.id } as any, DOCTOR);

      const created: ConsultationEntity = consultationRepository.create.mock.calls[0][0];
      expect(created.parentConsultationId).toBe(named.id);
    });

    it('a race on the open-key unique index returns the winner', async () => {
      const winner = seed(consultation({ id: 'c-winner' }));
      consultationRepository.findOpenByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      consultationRepository.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

      const result = await open({});

      expect(result.id).toBe(winner.id);
      expect(result.isNew).toBe(false);
      expect(result.encounterAppended).toBe(false);
      expect(consultationRepository.findOpenByKey).toHaveBeenCalledTimes(2);
    });
  });

  // ── 5. response fields ────────────────────────────────────────────────────
  describe('response fields', () => {
    it('carries processing, activity, the auto-close deadline, the encounter list and the lifecycle pair', async () => {
      const c = seed(
        consultation({
          status: ConsultationStatus.STOPPED,
          processing: ConsultationProcessing.AWAITING_REVIEW,
          processingReason: 'gate',
          reopenCount: 1,
          lastActivityAt: new Date('2026-10-05T08:00:00Z'),
        }),
      );
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({});

      expect(result.processing).toBe(ConsultationProcessing.AWAITING_REVIEW);
      expect(result.processingReason).toBe('gate');
      expect(result.lastActivityAt).toBe('2026-10-05T08:00:00.000Z');
      // idle mode: lastActivityAt + idleMinutes.
      expect(result.autoCloseAt).toBe('2026-10-05T20:00:00.000Z');
      expect(result.reopenCount).toBe(1);
      expect(result.closedReason).toBeNull();
      expect(result.closedAt).toBeNull();
      expect(result.reopenAllowed).toBe(false);
      expect(result.currentEncounterSeq).toBe(1);
      expect(result.approval).toBeNull();
      expect(result.recordable).toBe(true);
      expect(result.encounters).toEqual([
        {
          seq: 1,
          visitType: 'new-visit',
          externalRef: null,
          startedAt: '2026-10-01T08:00:00.000Z',
          endedAt: null,
          recordingStartMs: null,
          recordingEndMs: null,
        },
      ]);
      expect(result.lifecycle).toEqual({ status: ConsultationStatus.STOPPED, processing: ConsultationProcessing.AWAITING_REVIEW });
    });

    it('daily mode: the next dailyAt in the tenant time zone', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-05T10:00:00Z')); // 15:30 in Asia/Kolkata
      autoClose = { mode: 'daily', idleMinutes: 720, dailyAt: '23:00' };
      timeZone = 'Asia/Kolkata';
      const c = seed(consultation());
      consultationRepository.findOpenByKey.mockResolvedValue(c);

      const result = await open({});

      expect(result.autoCloseAt).toBe('2026-10-05T17:30:00.000Z');
    });

    it('a closed consultation has no auto-close deadline; CLOSED_INCOMPLETE may always be reopened', async () => {
      const c = seed(
        consultation({
          status: ConsultationStatus.CLOSED_INCOMPLETE,
          closedReason: ConsultationClosedReason.AUTO,
          closedAt: new Date('2026-10-05T20:00:00Z'),
        }),
      );
      const e = encounter(c, { externalRef: 'EVT-1' });
      encountersByConsultation.set(c.id, [e]);
      encounterRepository.findByExternalRef.mockResolvedValue([e]);

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(result.autoCloseAt).toBeNull();
      expect(result.reopenAllowed).toBe(true);
      expect(result.closedReason).toBe(ConsultationClosedReason.AUTO);
      expect(result.closedAt).toBe('2026-10-05T20:00:00.000Z');
      expect(result.recordable).toBe(false);
    });

    it('CLOSED_COMPLETE: the approval summary, and reopen follows the tenant policy', async () => {
      allowClosedComplete = true;
      const c = seed(consultation({ status: ConsultationStatus.CLOSED_COMPLETE, approvedAt: new Date('2026-10-05T09:00:00Z') }));
      const e = encounter(c, { externalRef: 'EVT-1' });
      encountersByConsultation.set(c.id, [e]);
      encounterRepository.findByExternalRef.mockResolvedValue([e]);
      approvalRepository.findLatestByConsultation.mockResolvedValue({
        id: 'ap-1',
        approvedAt: new Date('2026-10-05T09:00:00Z'),
        approvedBy: DOCTOR,
        snapshotHash: 'sha256:abc',
        snapshot: { items: [{ contextItemId: 'i1' }, { contextItemId: 'i2' }] },
      });

      const result = await open({ metadata: { externalRef: 'EVT-1' } });

      expect(approvalRepository.findLatestByConsultation).toHaveBeenCalledWith(c.id);
      expect(result.approval).toEqual({
        id: 'ap-1',
        approvedAt: '2026-10-05T09:00:00.000Z',
        approvedBy: DOCTOR,
        snapshotHash: 'sha256:abc',
        itemCount: 2,
      });
      expect(result.reopenAllowed).toBe(true);
    });
  });

  // ── 6. lifecycle commands delegate ────────────────────────────────────────
  describe('lifecycle commands delegate to the lifecycle service', () => {
    it('closeConsultation → lifecycle.close with the version, the named clinician and the caller', async () => {
      const response = { id: 'c-1' };
      lifecycle.close.mockResolvedValue(response);

      const result = await buildService().closeConsultation('c-1', 4, {
        clinicianUserId: 'doc-9',
        caller: { credentialClass: 'service-account', principalId: 'sa-1' },
      });

      expect(result).toBe(response);
      expect(lifecycle.close).toHaveBeenCalledWith('c-1', {
        expectedVersion: 4,
        clinicianUserId: 'doc-9',
        caller: { isMachine: true, serviceAccountId: 'sa-1' },
      });
    });

    it('reopenConsultation → lifecycle.reopen (the row version when the caller sent none)', async () => {
      seed(consultation({ id: 'c-7', status: ConsultationStatus.CLOSED_INCOMPLETE, version: 6 }));
      lifecycle.reopen.mockResolvedValue({ id: 'c-7' });

      await buildService().reopenConsultation('c-7', undefined, { reason: 'late addendum' });

      expect(lifecycle.reopen).toHaveBeenCalledWith('c-7', { expectedVersion: 6, reason: 'late addendum' });
    });

    it('startRecording → lifecycle.start, answered with the fresh consultation', async () => {
      const c = seed(consultation({ id: 'c-8', status: ConsultationStatus.RECORDING }));
      lifecycle.start.mockResolvedValue({ consultationId: c.id, status: 'RECORDING' });

      const result = await buildService().startRecording('c-8', { sttSessionId: 'stt-1', supersedeByDurableBinding: true });

      expect(lifecycle.start).toHaveBeenCalledWith('c-8', { sttSessionId: 'stt-1', supersedeByDurableBinding: true });
      expect(result.status).toBe(ConsultationStatus.RECORDING);
    });

    it('stopRecording → lifecycle.stop without waiting for the final transcript (the deprecated alias)', async () => {
      seed(consultation({ id: 'c-9', status: ConsultationStatus.STOPPED }));
      lifecycle.stop.mockResolvedValue({ consultationId: 'c-9' });

      const result = await buildService().stopRecording('c-9');

      expect(lifecycle.stop).toHaveBeenCalledWith('c-9', { waitForFinal: false });
      expect(result.status).toBe(ConsultationStatus.STOPPED);
    });

    it('primeConsultation is a no-op that answers the current consultation', async () => {
      seed(consultation({ id: 'c-10' }));

      const result = await buildService().primeConsultation('c-10');

      expect(result.status).toBe(ConsultationStatus.OPEN);
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(lifecycle.start).not.toHaveBeenCalled();
    });
  });
});
