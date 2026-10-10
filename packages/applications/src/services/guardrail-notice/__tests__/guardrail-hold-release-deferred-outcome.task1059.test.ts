/**
 * TASK-1059 (RC-9 hold row) — releasing a guardrail hold applies the note outcome the harness reported
 * while the hold stood (`metadata.guardrailHoldDeferredOutcome`, bound to that hold by its
 * `processingUpdatedAt`), instead of a bare IDLE that loses NOTE_READY / NOTE_COVERAGE_GAPS. An outcome
 * recorded against an EARLIER hold is stale and ignored.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./support/w0-domains')),
}));

import {
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  GuardrailDirection,
  GuardrailNoticeFactory,
  GuardrailNoticeType,
} from '@arcaai/domains';
import { GuardrailNoticeService } from '../guardrail-notice.service';
import { GUARDRAIL_DEFERRED_OUTCOME_KEY } from '../guardrail-hold.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const DOCTOR = 'doctor-1';
const HELD_AT = new Date('2026-10-10T08:00:00.000Z');

function blockNotice() {
  return GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: TENANT,
    consultationId: CONSULTATION,
    runId: null,
    nodeId: null,
    type: GuardrailNoticeType.BLOCKED,
    direction: GuardrailDirection.OUTBOUND,
    action: 'block',
    checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'high' }] as never,
    itemIds: [],
    messageKey: 'guardrail.blocked.outbound',
    severity: 'high',
    requiresAcknowledgement: true,
    resumable: true,
    policyVersion: 'pv-1',
    dedupeKey: 'dk',
  });
}

function harness(deferred: Record<string, unknown> | null) {
  const notice = blockNotice();
  const row = {
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: DOCTOR,
    appointmentDate: new Date('2026-10-10'),
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.AWAITING_REVIEW,
    processingReason: 'GUARDRAIL_HOLD',
    processingUpdatedAt: HELD_AT,
    metadata: deferred ? { [GUARDRAIL_DEFERRED_OUTCOME_KEY]: deferred } : null,
    closedReason: null,
    currentEncounterSeq: 1,
    version: 7,
    createdAt: new Date('2026-10-10'),
    updatedAt: new Date('2026-10-10'),
  };
  const consultations = {
    findByIdOrNull: vi.fn(async () => new ConsultationEntity({ ...row } as never)),
    setProcessing: vi.fn(async () => true),
  };
  const notices = {
    findByIdOrNull: vi.fn(async () => notice),
    findAll: vi.fn(async () => []),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const lifecycleEvents = { publish: vi.fn(async () => ({})) };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)), set: vi.fn() };
  const service = new GuardrailNoticeService(
    consultations as never,
    notices as never,
    { findByConsultation: vi.fn(async () => []) } as never,
    { findAll: vi.fn(async () => []), setGuardrailStatusMany: vi.fn() } as never,
    { emit: vi.fn() } as never,
    cls as never,
    { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as never,
    lifecycleEvents as never,
    { append: vi.fn(async () => ({})) } as never,
    undefined,
    undefined,
    { findAll: vi.fn(async () => []) } as never,
  );
  return { service, notice, consultations, lifecycleEvents };
}

async function resume(h: ReturnType<typeof harness>) {
  await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, clinicianUserId: undefined });
}

describe('GuardrailNoticeService.resumeHold — the release applies the deferred note outcome (TASK-1059)', () => {
  it('IDLE + NOTE_READY deferred during this hold: the release writes and announces it', async () => {
    const h = harness({ processing: 'IDLE', reason: 'NOTE_READY', holdSince: HELD_AT.toISOString() });
    await resume(h);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.IDLE, { reason: 'NOTE_READY' }, 'tx');
    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({ processing: ConsultationProcessing.IDLE, processingReason: 'NOTE_READY' }),
      'processing_changed',
      { noticeId: h.notice.id },
    );
  });

  it('AWAITING_REVIEW + NOTE_COVERAGE_GAPS deferred: the release returns to it', async () => {
    const h = harness({ processing: 'AWAITING_REVIEW', reason: 'NOTE_COVERAGE_GAPS:2', holdSince: HELD_AT.toISOString() });
    await resume(h);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(
      CONSULTATION,
      ConsultationProcessing.AWAITING_REVIEW,
      { reason: 'NOTE_COVERAGE_GAPS:2' },
      'tx',
    );
  });

  it('an outcome recorded against an earlier hold is stale: a bare IDLE, as before', async () => {
    const h = harness({ processing: 'FAILED', reason: 'NOTE_GENERATION_FAILED', holdSince: '2026-10-01T00:00:00.000Z' });
    await resume(h);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.IDLE, { reason: null }, 'tx');
  });

  it('nothing deferred: a bare IDLE, as before', async () => {
    const h = harness(null);
    await resume(h);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.IDLE, { reason: null }, 'tx');
    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({ processing: ConsultationProcessing.IDLE, processingReason: null }),
      'processing_changed',
      { noticeId: h.notice.id },
    );
  });
});
