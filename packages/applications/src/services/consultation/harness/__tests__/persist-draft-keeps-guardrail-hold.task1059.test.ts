/**
 * TASK-1059 (TASK-1058 RC-9 hold row) — the note writer never overwrites a real guardrail hold.
 *
 * `persistDraft` used to move a STOPPED consultation to IDLE + NOTE_READY (or AWAITING_REVIEW +
 * NOTE_COVERAGE_GAPS:n) whatever processing said, so a consultation held on GUARDRAIL_HOLD silently lost
 * its hold while its blocking notice stayed OPEN. Now, while an unresolved (OPEN / ACKNOWLEDGED) BLOCKED
 * notice exists, the hold is kept and the note's outcome is recorded on the consultation's metadata
 * (`guardrailHoldDeferredOutcome`, stamped with the hold's `processingUpdatedAt`) so the release applies
 * it. A hold with nothing unresolved behind it (stranded) is overwritten as before.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_PHASE } from '../dto';
import { NOTE_READY_REASON } from '../../lifecycle/legacy-status-projection';
import { GUARDRAIL_DEFERRED_OUTCOME_KEY } from '../../../guardrail-notice/guardrail-hold.service';

const TENANT = '50000000-0000-0000-0000-000000000059';
const CID = '0199a000-0000-7000-8000-0000000000e1';
const HELD_AT = new Date('2026-10-10T08:00:00.000Z');

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function heldConsultation(overrides: Record<string, unknown> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-10'),
    metadata: { keep: 'me' },
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.AWAITING_REVIEW,
    processingReason: 'GUARDRAIL_HOLD',
    processingUpdatedAt: HELD_AT,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-10'),
    updatedAt: new Date('2026-10-10'),
    createdBy: 'user-1',
    version: 7,
    ...overrides,
  } as never);
}

const block = (status: string) => ({ id: 'n-1', tenantId: TENANT, consultationId: CID, type: 'BLOCKED', direction: 'OUTBOUND', status });

function build(row: ConsultationEntity, notices: Array<Record<string, unknown>>) {
  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([]),
    findByType: vi.fn(async (_cid: string, type: ContextItemType) => (type === ContextItemType.RAW_SUMMARY ? [] : [])),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    findById: vi.fn(async (id: string) => ({ id, content: 'note' })),
    create: vi.fn(async (entity: Record<string, unknown>) => ({ ...entity, id: 'ctx-new' })),
    update: vi.fn(),
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>) => ({ ...entity, id })),
    encryptContentIntoEntity: vi.fn(),
    setGuardrailStatus: vi.fn(),
  };
  const consultationRepository = {
    findById: vi.fn(async () => row),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const summaryMetaRepository = {
    findByContextItem: vi.fn(async () => null),
    updateWithVersion: vi.fn(async () => ({ id: 'sm-1' })),
    encryptFieldsIntoEntity: vi.fn(),
    create: vi.fn(async () => ({ id: 'sm-new' })),
  };
  const lifecycleGate = { assertContentWritable: vi.fn(), setProcessing: vi.fn().mockResolvedValue(undefined) };
  const guardrailNotices = { findAll: vi.fn(async () => notices) };
  const positional: unknown[] = [
    contextItemRepository,
    consultationRepository,
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) },
    summaryMetaRepository,
    { assemble: vi.fn() },
    { findById: vi.fn() },
    { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    createMockCls(),
    ...Array.from({ length: 16 }, () => undefined), // jobService … progressService
    { emit: vi.fn() }, // eventEmitter
    undefined, // routingPolicies
    undefined, // effectiveSettings
    undefined, // dnaReportRepository
    lifecycleGate,
    undefined, // noteComposer
    guardrailNotices,
  ];
  const service = new (HarnessInternalService as unknown as new (...args: unknown[]) => HarnessInternalService)(...positional);
  return { service, consultationRepository, lifecycleGate, guardrailNotices, summaryMetaRepository };
}

const draft = (extra: Record<string, unknown> = {}) =>
  ({ tenantId: TENANT, userId: 'harness', content: '## Subjective\nCough.', modelName: 'm', modelVersion: 'v', ...extra }) as never;

describe('persistDraft — keeps a real guardrail hold (TASK-1059)', () => {
  it.each(['OPEN', 'ACKNOWLEDGED'])('an unresolved (%s) block: processing untouched, the outcome deferred onto the metadata', async (status) => {
    const row = heldConsultation();
    const { service, lifecycleGate, consultationRepository } = build(row, [block(status)]);

    await service.persistDraft(CID, draft());

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    const [id, entity, expectedVersion] = consultationRepository.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity, number];
    expect(id).toBe(CID);
    expect(expectedVersion).toBe(7);
    expect(entity.metadata).toEqual({
      keep: 'me',
      [GUARDRAIL_DEFERRED_OUTCOME_KEY]: { processing: ConsultationProcessing.IDLE, reason: NOTE_READY_REASON, holdSince: HELD_AT.toISOString() },
    });
    expect(row.processing).toBe(ConsultationProcessing.AWAITING_REVIEW);
    expect(row.processingReason).toBe('GUARDRAIL_HOLD');
  });

  it('only RESOLVED blocks behind the hold (stranded): the note outcome is written as before', async () => {
    const { service, lifecycleGate, consultationRepository } = build(heldConsultation(), [block('RESOLVED')]);
    await service.persistDraft(CID, draft());
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a consultation that is not held is unaffected (no notice lookup for the hold)', async () => {
    const row = heldConsultation({ processing: ConsultationProcessing.SUMMARIZING, processingReason: null });
    const { service, lifecycleGate, consultationRepository } = build(row, [block('OPEN')]);
    await service.persistDraft(CID, draft());
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('an EARLY draft during a hold defers SUMMARIZING; finalizeAssurance then moves the deferred outcome to IDLE + NOTE_READY', async () => {
    const row = heldConsultation();
    const { service, lifecycleGate, consultationRepository, summaryMetaRepository } = build(row, [block('OPEN')]);
    await service.persistDraft(CID, draft({ phase: HARNESS_DRAFT_PHASE.EARLY }));
    summaryMetaRepository.findByContextItem.mockResolvedValue({ id: 'sm-new', version: 1, citationsMap: null } as never);
    const deferredEarly = (consultationRepository.updateWithVersion.mock.calls[0]![1] as ConsultationEntity).metadata as Record<string, any>;
    expect(deferredEarly[GUARDRAIL_DEFERRED_OUTCOME_KEY]).toMatchObject({ processing: ConsultationProcessing.SUMMARIZING, reason: null });

    await service.finalizeAssurance(CID, { tenantId: TENANT, contextItemId: 'ctx-new' } as never);
    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
    const last = consultationRepository.updateWithVersion.mock.calls.at(-1)![1] as ConsultationEntity;
    expect((last.metadata as Record<string, any>)[GUARDRAIL_DEFERRED_OUTCOME_KEY]).toMatchObject({
      processing: ConsultationProcessing.IDLE,
      reason: NOTE_READY_REASON,
    });
  });
});
