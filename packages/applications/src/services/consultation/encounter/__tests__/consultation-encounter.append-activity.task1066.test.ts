/**
 * Starting a new encounter is activity: `appendEncounter` moves `lastActivityAt` to now in the same
 * OCC write as the new encounter seq, so the idle auto-close deadline counts from the new encounter,
 * not from the previous one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ConsultationEntity: (await import('../../../../../../domains/src/entities/generated/core/ConsultationEntity')).ConsultationEntity,
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationEncounterService } from '../consultation-encounter.service';

const PREVIOUS_ACTIVITY = new Date('2026-10-13T08:00:00Z');
const NOW = new Date('2026-10-13T09:30:00Z');

function consultation(): ConsultationEntity {
  return new ConsultationEntity({
    id: 'c-1',
    tenantId: 't-1',
    patientId: 'p-1',
    doctorId: 'd-1',
    appointmentDate: new Date('2026-10-13'),
    metadata: null,
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.IDLE,
    processingReason: null,
    currentEncounterSeq: 1,
    lastActivityAt: PREVIOUS_ACTIVITY,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-13T07:00:00Z'),
    updatedAt: PREVIOUS_ACTIVITY,
    createdBy: 'u-1',
    updatedBy: null,
    version: 4,
  } as never);
}

function build() {
  const consultationRepository = { updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity) => entity) };
  const encounterRepository = { endEncounter: vi.fn(async () => undefined), create: vi.fn(async (entity: unknown) => entity) };
  const databaseService = { baseClient: { $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } };
  const service = new ConsultationEncounterService(
    encounterRepository as never,
    consultationRepository as never,
    {} as never,
    databaseService as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn() } as never,
  );
  return { service, consultationRepository };
}

describe('ConsultationEncounterService.appendEncounter — activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('writes lastActivityAt = now with the new encounter, so autoCloseAt counts from it', async () => {
    const { service, consultationRepository } = build();
    const { consultation: appended } = await service.appendEncounter(consultation(), {
      actor: 'u-1',
      visitType: 'FOLLOW_UP',
      externalRef: null,
    } as never);

    const [, written] = consultationRepository.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity];
    expect(written.currentEncounterSeq).toBe(2);
    expect(written.changes).toHaveProperty('lastActivityAt', NOW);
    expect(appended.lastActivityAt).toEqual(NOW);
  });
});
