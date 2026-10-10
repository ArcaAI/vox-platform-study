/**
 * TASK-1059 RC-10 — an encounter append persists the new encounter's IDLE processing.
 *
 * The rule lives on `ConsultationEntity.beginNextEncounter` (the previous encounter's note outcome is
 * reset; in-flight work and a real guardrail hold are kept); `appendEncounter` persists it in the same
 * OCC write as the new encounter seq. The entity is loaded from the worktree's domains SOURCE — the
 * `@arcaai/domains` dist a lane resolves predates this ticket.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ConsultationEntity: (await import('../../../../../../domains/src/entities/generated/core/ConsultationEntity')).ConsultationEntity,
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { ConsultationEncounterService } from '../consultation-encounter.service';

function consultation(processing: ConsultationProcessing, processingReason: string | null): ConsultationEntity {
  return new ConsultationEntity({
    id: 'c-1',
    tenantId: 't-1',
    patientId: 'p-1',
    doctorId: 'd-1',
    appointmentDate: new Date('2026-10-10'),
    metadata: null,
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing,
    processingReason,
    currentEncounterSeq: 1,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-10'),
    updatedAt: new Date('2026-10-10'),
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

describe('ConsultationEncounterService.appendEncounter — processing reset (RC-10)', () => {
  it.each([
    [ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:1'],
    [ConsultationProcessing.FAILED, 'NOTE_GENERATION_FAILED'],
    [ConsultationProcessing.IDLE, 'NOTE_READY'],
  ])('the previous note outcome (%s / %s) is written as IDLE with the new encounter', async (processing, reason) => {
    const { service, consultationRepository } = build();
    await service.appendEncounter(consultation(processing, reason), { actor: 'u-1', visitType: 'FOLLOW_UP', externalRef: null } as never);

    const [, written, expectedVersion] = consultationRepository.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity, number];
    expect(expectedVersion).toBe(4);
    expect(written.currentEncounterSeq).toBe(2);
    expect(written.processing).toBe(ConsultationProcessing.IDLE);
    expect(written.processingReason).toBeNull();
    expect(written.changes).toHaveProperty('processingReason', null);
  });

  it('a real guardrail hold is kept across the append (documented: only resume / approve resolve it)', async () => {
    const { service, consultationRepository } = build();
    await service.appendEncounter(consultation(ConsultationProcessing.AWAITING_REVIEW, 'GUARDRAIL_HOLD'), {
      actor: 'u-1',
      visitType: 'FOLLOW_UP',
      externalRef: null,
    } as never);
    const [, written] = consultationRepository.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity];
    expect(written.processing).toBe(ConsultationProcessing.AWAITING_REVIEW);
    expect(written.processingReason).toBe('GUARDRAIL_HOLD');
  });
});
