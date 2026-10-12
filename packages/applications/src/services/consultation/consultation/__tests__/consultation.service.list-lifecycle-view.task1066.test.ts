/**
 * A consultation LIST answers the same episode facts a single read does — encounters, approval,
 * auto-close deadline, reopen policy — loaded for the whole page in two extra queries, never one
 * per row. `isNew` stays false on a list by design.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { ConsultationEncounterService } from '../../encounter/consultation-encounter.service';
import { lifecycleDouble } from './consultation-service.fixture';
import { CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY } from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { CONSULTATION_AUTO_CLOSE_SETTING_KEY, CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY } from '../../encounter/lifecycle-view';

const TENANT = 'tenant-1';
const LAST_ACTIVITY = new Date('2026-10-05T08:00:00Z');

function row(i: number, overrides: Record<string, unknown> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: `c-${i}`,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-05'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    externalRef: null,
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: i === 0 ? 2 : 1,
    lastActivityAt: LAST_ACTIVITY,
    degradedReasons: [],
    createdAt: new Date('2026-10-05T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
    createdBy: 'doctor-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    version: 2,
    ...overrides,
  } as any);
}

const encounterRow = (consultationId: string, seq: number) => ({
  id: `e-${consultationId}-${seq}`,
  tenantId: TENANT,
  consultationId,
  seq,
  visitType: seq === 1 ? 'new-visit' : 'revisit',
  externalRef: seq === 1 ? `EVT-${consultationId}` : `EVT-${consultationId}-b`,
  startedAt: new Date('2026-10-05T08:00:00Z'),
  endedAt: null,
  recordingStartMs: null,
  recordingEndMs: null,
});

describe('ConsultationService lists — the lifecycle view, batch-loaded', () => {
  let rows: ConsultationEntity[];
  let consultationRepository: any;
  let encounterRepository: any;
  let approvalRepository: any;

  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: 'doctor-1', tenantId: TENANT };
      return null;
    }),
    set: vi.fn(),
  };

  const tenantSettings = {
    resolve: vi.fn((key: string) => {
      if (key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY) return { key, value: 'UTC' };
      if (key === CONSULTATION_AUTO_CLOSE_SETTING_KEY) return { key, value: { mode: 'idle', idleMinutes: 720, dailyAt: null } };
      if (key === CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY) return { key, value: false };
      throw new Error(`Unknown setting '${key}'.`);
    }),
  };

  const buildService = () =>
    new ConsultationService(
      consultationRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { emit: vi.fn() } as any,
      cls as any,
      new ConsultationEncounterService(encounterRepository, consultationRepository, approvalRepository, {} as any, { emit: vi.fn() } as any, cls as any, tenantSettings as any),
      lifecycleDouble() as any,
      undefined,
      tenantSettings as any,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    rows = Array.from({ length: 25 }, (_, i) => row(i, i === 3 ? { status: ConsultationStatus.APPROVED } : {}));
    consultationRepository = {
      findPaginatedWithRelations: vi.fn(async () => rows),
      count: vi.fn(async () => 25),
      findAll: vi.fn(async () => rows),
    };
    encounterRepository = {
      findByConsultations: vi.fn(async (ids: string[]) => ids.flatMap((id) => [encounterRow(id, 1), ...(id === 'c-0' ? [encounterRow(id, 2)] : [])])),
      findByConsultation: vi.fn(async () => []),
    };
    approvalRepository = {
      findLatestByConsultations: vi.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, { id: `ap-${id}`, approvedAt: new Date('2026-10-05T09:00:00Z'), approvedBy: 'doctor-1', snapshotHash: 'h', snapshot: { items: [{}] } }])),
      ),
      findLatestByConsultation: vi.fn(async () => null),
    };
  });

  it('the admin list (listConsultationsForTenant) fills encounters, approval and autoCloseAt for 25 rows with one call to each batch repository', async () => {
    const page = await buildService().listConsultationsForTenant({ page: 1, pageSize: 25 });

    expect(page.data).toHaveLength(25);
    expect(encounterRepository.findByConsultations).toHaveBeenCalledTimes(1);
    expect(encounterRepository.findByConsultation).not.toHaveBeenCalled();
    expect(approvalRepository.findLatestByConsultations).toHaveBeenCalledTimes(1);
    expect(approvalRepository.findLatestByConsultation).not.toHaveBeenCalled();

    const first = page.data[0];
    expect(first.encounters.map((e) => e.seq)).toEqual([1, 2]);
    // The CURRENT encounter's ref and visit type, not the row's.
    expect(first.externalRef).toBe('EVT-c-0-b');
    expect(first.visitType).toBe('revisit');
    expect(first.autoCloseAt).toBe(new Date(LAST_ACTIVITY.getTime() + 720 * 60_000).toISOString());
    expect(first.isNew).toBe(false);

    const approved = page.data[3];
    expect(approved.approval).toMatchObject({ id: 'ap-c-3', approvedBy: 'doctor-1', itemCount: 1 });
    expect(page.data[1].approval).toBeNull();
    expect(page.data[1].encounters.map((e) => e.seq)).toEqual([1]);
  });

  it('every other list path answers with the view too (patient history, paginated history, doctor list)', async () => {
    const service = buildService();

    const history = await service.getPatientHistory('patient-1');
    const paged = await service.getPatientHistoryPaginated('patient-1', 1, 25);
    const listed = await service.listConsultations({ page: 1, pageSize: 25 });

    for (const answer of [history, paged.data, listed.data]) {
      expect(answer[0].encounters.map((e) => e.seq)).toEqual([1, 2]);
      expect(answer[0].autoCloseAt).not.toBeNull();
    }
    expect(encounterRepository.findByConsultations).toHaveBeenCalledTimes(3);
  });

  it('an empty page reads nothing more', async () => {
    rows = [];
    const page = await buildService().listConsultationsForTenant({ page: 1, pageSize: 25 });

    expect(page.data).toEqual([]);
    expect(encounterRepository.findByConsultations).not.toHaveBeenCalled();
    expect(approvalRepository.findLatestByConsultations).not.toHaveBeenCalled();
  });
});
