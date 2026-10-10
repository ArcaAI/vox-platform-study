/**
 * TASK-1059 (TASK-1058 RC-8 / RC-9 hold rows) — a guardrail evaluation never enters a consultation's
 * hold on behalf of a run that is OVER. The evaluation outbox drains asynchronously, so a block can land
 * after its run has ended (timed out on the hold, failed GUARDRAIL_BLOCKED) or after the consultation's
 * governing run was SUPERSEDED by a resume. Holding then strands the consultation: nothing is paused on
 * the notice, and a resume only starts yet another run.
 *
 * The run's state is the consultation's governing marker (`metadata.governingEngine`): the run it names
 * and that run's stamped terminal `runStatus`. No marker (a consultation no tenant graph governs) and no
 * run id on the evaluation (a live-summary tick) keep the old behaviour.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GuardrailEvaluationRecord, GuardrailNotice } from '@arcaai/types';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';
import { GuardrailEvaluationIngestService } from '../guardrail-evaluation-ingest.service';
import { GuardrailHoldService } from '../../guardrail-notice/guardrail-hold.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const CONSULTATION = '01927f6e-0000-7000-8000-000000000001';

function blockNotice(overrides: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return {
    schemaVersion: 1,
    noticeId: '01927f6e-9999-7000-8000-0000000000bb',
    type: 'guardrail.blocked',
    direction: 'outbound',
    action: 'block',
    checks: [{ checkId: 'pii_leak', category: 'encounter_id', severity: 'high' }],
    consultationId: CONSULTATION,
    runId: 'run-1',
    nodeId: 'n_note',
    itemIds: [],
    messageKey: 'guardrail.blocked.outbound',
    defaultMessage: 'A safety check withheld this output.',
    requiresAcknowledgement: true,
    resumable: true,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...overrides,
  };
}

function blockRecord(overrides: Partial<GuardrailEvaluationRecord> = {}): GuardrailEvaluationRecord {
  const notice = blockNotice({ runId: overrides.runId ?? 'run-1' });
  return {
    evaluationId: '01927f6e-8b1a-7c3e-9d2f-1a2b3c4d5e61',
    tenantId: TENANT,
    requestId: 'req-1',
    consultationId: CONSULTATION,
    runId: 'run-1',
    nodeId: 'n_note',
    caller: 'text.generate',
    direction: 'outbound',
    decision: 'block',
    checks: [
      {
        checkId: 'pii_leak',
        verdict: 'flag',
        category: 'encounter_id',
        actionTaken: 'block',
        model: 'gliner2',
        latencyMs: 12,
        regionKeys: ['response'],
        items: [],
      },
    ],
    policyVersion: 'pv-1',
    noticeIds: [notice.noticeId],
    notices: [notice],
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...overrides,
  } as GuardrailEvaluationRecord;
}

function marker(workflowRunId: string, runStatus?: string) {
  return {
    governingEngine: {
      engine: 'tenant-workflow',
      workflowRunId,
      workflowDefinitionSlug: 'scribe',
      decidedAt: '2026-10-07T09:00:00.000Z',
      ...(runStatus ? { runStatus } : {}),
    },
  };
}

function makeHarness(metadata: unknown) {
  const evaluations = {
    findAll: vi.fn(async () => []),
    createManyIdempotent: vi.fn(async (entities: unknown[]) => ({ inserted: entities.length, duplicates: 0 })),
  };
  const notices = { upsertByDedupeKey: vi.fn(async (entity: unknown) => ({ notice: entity, created: true })) };
  const contextItems = { findAll: vi.fn(async () => []), setGuardrailStatusMany: vi.fn(async () => 0) };
  const consultations = {
    findByIdOrNull: vi.fn(async () => ({
      id: CONSULTATION,
      tenantId: TENANT,
      status: ConsultationStatus.STOPPED,
      processing: ConsultationProcessing.IDLE,
      processingReason: null,
      closedReason: null,
      currentEncounterSeq: 1,
      version: 4,
      metadata,
    })),
    setProcessing: vi.fn(async () => true),
  };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) };
  const events = { publish: vi.fn(async () => ({})) };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn(), run: vi.fn((fn: () => unknown) => fn()) };
  const holds = new GuardrailHoldService(consultations as never, notices as never, eventEmitter as never, cls as never, undefined, events as never, undefined);
  const service = new GuardrailEvaluationIngestService(
    evaluations as never,
    notices as never,
    contextItems as never,
    eventEmitter as never,
    cls as never,
    unitOfWork as never,
    holds,
    undefined,
  );
  return { service, consultations, evaluations, notices, events };
}

describe('GuardrailEvaluationIngestService.ingest — no hold for a run that is over (TASK-1059)', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'])('the governing run ended %s: the block is recorded, never held', async (runStatus) => {
    const h = makeHarness(marker('run-1', runStatus));
    const result = await h.service.ingest(TENANT, { evaluations: [blockRecord()] });

    expect(result).toEqual({ accepted: 1, duplicates: 0 });
    expect(h.notices.upsertByDedupeKey).toHaveBeenCalledTimes(1);
    expect(h.evaluations.createManyIdempotent).toHaveBeenCalledTimes(1);
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(h.events.publish).not.toHaveBeenCalled();
  });

  it('the run was superseded (the marker names another run): no hold', async () => {
    const h = makeHarness(marker('run-2'));
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
  });

  it('the run still governs and has not ended: the hold is entered', async () => {
    const h = makeHarness(marker('run-1'));
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.AWAITING_REVIEW, { reason: 'GUARDRAIL_HOLD' }, 'tx');
  });

  it('the run id is read off the notice when the record carries none', async () => {
    const h = makeHarness(marker('run-2'));
    const record = blockRecord();
    await h.service.ingest(TENANT, { evaluations: [{ ...record, runId: undefined }] });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
  });

  it('no governing marker, or no run on the evaluation: unchanged — the hold is entered', async () => {
    const ungoverned = makeHarness(null);
    await ungoverned.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(ungoverned.consultations.setProcessing).toHaveBeenCalledTimes(1);

    const runless = makeHarness(marker('run-1', 'FAILED'));
    const record = blockRecord();
    const notice = { ...record.notices![0], runId: undefined };
    await runless.service.ingest(TENANT, { evaluations: [{ ...record, runId: undefined, notices: [notice] }] });
    expect(runless.consultations.setProcessing).toHaveBeenCalledTimes(1);
  });
});
