/**
 * `lifecycleViews` — the episode facts of a LIST page, loaded in a constant number of queries:
 * one encounter read and one approval read for the whole page, the tenant settings resolved once
 * per distinct tenant, and each row's view identical to what `lifecycleView` answers for it alone.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationEncounterService } from '../consultation-encounter.service';
import { CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY } from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { CONSULTATION_AUTO_CLOSE_SETTING_KEY, CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY } from '../lifecycle-view';

const LAST_ACTIVITY = new Date('2026-10-05T08:00:00Z');

function row(i: number, overrides: Record<string, unknown> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: `c-${i}`,
    tenantId: 't-1',
    patientId: `p-${i}`,
    doctorId: 'd-1',
    appointmentDate: new Date('2026-10-05'),
    metadata: null,
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: 1,
    lastActivityAt: LAST_ACTIVITY,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-05'),
    updatedAt: new Date('2026-10-05'),
    createdBy: 'd-1',
    updatedBy: null,
    version: 1,
    ...overrides,
  } as never);
}

const encounterRow = (consultationId: string, seq: number) => ({
  id: `e-${consultationId}-${seq}`,
  tenantId: 't-1',
  consultationId,
  seq,
  visitType: seq === 1 ? 'new-visit' : 'revisit',
  externalRef: null,
  startedAt: new Date('2026-10-05T08:00:00Z'),
  endedAt: null,
  recordingStartMs: null,
  recordingEndMs: null,
});

function build(rows: ConsultationEntity[]) {
  const encounterRepository = {
    findByConsultations: vi.fn(async (ids: string[]) => ids.flatMap((id) => [encounterRow(id, 1), ...(id === 'c-0' ? [encounterRow(id, 2)] : [])])),
    findByConsultation: vi.fn(),
  };
  const approvalRepository = {
    findLatestByConsultations: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            { id: `ap-${id}`, approvedAt: new Date('2026-10-05T09:00:00Z'), approvedBy: 'd-1', snapshotHash: 'h', snapshot: { items: [{}, {}] } },
          ]),
        ),
    ),
    findLatestByConsultation: vi.fn(),
  };
  const tenantSettings = {
    resolve: vi.fn((key: string, tenantId: string) => {
      if (key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY) return { key, value: 'UTC' };
      if (key === CONSULTATION_AUTO_CLOSE_SETTING_KEY)
        return { key, value: { mode: 'idle', idleMinutes: tenantId === 't-2' ? 30 : 720, dailyAt: null } };
      if (key === CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY) return { key, value: tenantId === 't-2' };
      throw new Error(`Unknown setting '${key}'.`);
    }),
  };
  const service = new ConsultationEncounterService(
    encounterRepository as any,
    {} as any,
    approvalRepository as any,
    {} as any,
    { emit: vi.fn() } as any,
    { get: vi.fn(), set: vi.fn() } as any,
    tenantSettings as any,
  );
  void rows;
  return { service, encounterRepository, approvalRepository, tenantSettings };
}

describe('ConsultationEncounterService.lifecycleViews — a page of consultations in constant queries', () => {
  it('reads the encounters and approvals of 25 rows with ONE call to each batch repository', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i, i % 5 === 0 ? { status: ConsultationStatus.APPROVED } : {}));
    const { service, encounterRepository, approvalRepository } = build(rows);

    const views = await service.lifecycleViews(rows);

    expect(encounterRepository.findByConsultations).toHaveBeenCalledTimes(1);
    expect(encounterRepository.findByConsultations).toHaveBeenCalledWith(rows.map((r) => r.id));
    expect(encounterRepository.findByConsultation).not.toHaveBeenCalled();
    expect(approvalRepository.findLatestByConsultations).toHaveBeenCalledTimes(1);
    // Only an approved consultation carries an approval, so only those are asked for.
    expect(approvalRepository.findLatestByConsultations).toHaveBeenCalledWith(['c-0', 'c-5', 'c-10', 'c-15', 'c-20']);
    expect(approvalRepository.findLatestByConsultation).not.toHaveBeenCalled();

    expect(views.size).toBe(25);
    expect(views.get('c-0')!.encounters.map((e) => e.seq)).toEqual([1, 2]);
    expect(views.get('c-3')!.encounters.map((e) => e.seq)).toEqual([1]);
    expect(views.get('c-0')!.approval).toMatchObject({ id: 'ap-c-0', approvedBy: 'd-1', itemCount: 2 });
    expect(views.get('c-3')!.approval).toBeNull();
    expect(views.get('c-3')!.autoCloseAt).toEqual(new Date(LAST_ACTIVITY.getTime() + 720 * 60_000));
  });

  it('resolves the settings once per DISTINCT tenant, and applies each tenant its own', async () => {
    const rows = [row(1), row(2), row(3, { tenantId: 't-2', status: ConsultationStatus.CLOSED_COMPLETE }), row(4, { tenantId: 't-2' })];
    const { service, tenantSettings } = build(rows);

    const views = await service.lifecycleViews(rows);

    const autoCloseReads = tenantSettings.resolve.mock.calls.filter(([key]) => key === CONSULTATION_AUTO_CLOSE_SETTING_KEY);
    expect(autoCloseReads.map(([, tenantId]) => tenantId).sort()).toEqual(['t-1', 't-2']);
    expect(views.get('c-1')!.autoCloseAt).toEqual(new Date(LAST_ACTIVITY.getTime() + 720 * 60_000));
    expect(views.get('c-4')!.autoCloseAt).toEqual(new Date(LAST_ACTIVITY.getTime() + 30 * 60_000));
    // A closed consultation has no deadline.
    expect(views.get('c-3')!.autoCloseAt).toBeNull();
    expect(views.get('c-3')!.allowClosedCompleteReopen).toBe(true);
    expect(views.get('c-1')!.allowClosedCompleteReopen).toBe(false);
  });

  it('answers an empty map for an empty page without touching a repository', async () => {
    const { service, encounterRepository, approvalRepository } = build([]);

    await expect(service.lifecycleViews([])).resolves.toEqual(new Map());
    expect(encounterRepository.findByConsultations).not.toHaveBeenCalled();
    expect(approvalRepository.findLatestByConsultations).not.toHaveBeenCalled();
  });
});
