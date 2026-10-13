/**
 * One harness note per encounter: a draft delivered for a NEW encounter creates its own
 * RAW_SUMMARY stamped with that encounter, while a re-delivery for the SAME encounter still
 * updates the existing row in place.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_SUBTYPE } from '../harness-draft.constants';

const TENANT = '50000000-0000-0000-0000-000000000050';
const CID = '0199a000-0000-7000-8000-0000000000e1';

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function consultation(currentEncounterSeq: number): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-07'),
    metadata: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-1', workflowDefinitionSlug: 'wf' } },
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.SUMMARIZING,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-07'),
    updatedAt: new Date('2026-10-07'),
    createdBy: 'user-1',
    currentEncounterSeq,
    version: 3,
  } as never);
}

function draftRow(id: string, encounterSeq: number | null, content: string) {
  return {
    id,
    type: ContextItemType.RAW_SUMMARY,
    encounterSeq,
    content,
    version: 4,
    currentVersionNumber: 1,
    metaData: { subType: HARNESS_DRAFT_SUBTYPE },
    createdAt: new Date('2026-10-07T10:00:00Z'),
  };
}

function build(currentEncounterSeq: number, drafts: Array<Record<string, unknown>>) {
  const contextItemRepository = {
    findTranscripts: vi.fn(async () => []),
    findCaseNotes: vi.fn(async () => []),
    findWorknotes: vi.fn(async () => []),
    findAttachments: vi.fn(async () => []),
    findByType: vi.fn(async (_cid: string, type: string) => (type === ContextItemType.RAW_SUMMARY ? drafts : [])),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: Record<string, unknown>) => entity),
    setGuardrailStatus: vi.fn(async () => undefined),
    updateWithVersion: vi.fn(async () => undefined),
    encryptContentIntoEntity: vi.fn(),
  };
  const summaryMetaRepository = { findByContextItem: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn(), encryptFieldsIntoEntity: vi.fn() };
  const lifecycleGate = { assertContentWritable: vi.fn(), setProcessing: vi.fn() };
  const positional: unknown[] = [
    contextItemRepository,
    { findById: vi.fn(async () => consultation(currentEncounterSeq)) },
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) },
    summaryMetaRepository,
    { assemble: vi.fn(async () => ({ systemPrompt: 'S', userPrompt: 'U' })) },
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
    { findAll: vi.fn(async () => []) },
  ];
  const service = new (HarnessInternalService as unknown as new (...args: unknown[]) => HarnessInternalService)(...positional);
  return { service, contextItemRepository };
}

describe('persistDraft — one note per encounter', () => {
  it('creates a NEW note for encounter 2 instead of re-versioning the encounter-1 note', async () => {
    const { service, contextItemRepository } = build(2, [draftRow('note-enc-1', 1, 'The note of visit one.')]);
    await service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'The note of visit two.' } as never).catch(() => undefined);

    expect(contextItemRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [
      { type: string; encounterSeq: number | null; currentVersionNumber: number },
    ];
    expect(created.type).toBe(ContextItemType.RAW_SUMMARY);
    expect(created.encounterSeq).toBe(2);
    expect(created.currentVersionNumber).toBe(1);
  });

  it('a re-delivery for the SAME encounter still updates that encounter’s note in place', async () => {
    const { service, contextItemRepository } = build(2, [
      draftRow('note-enc-1', 1, 'The note of visit one.'),
      { ...draftRow('note-enc-2', 2, 'The note of visit two.'), createdAt: new Date('2026-10-07T11:00:00Z') },
    ]);
    await service
      .persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'The note of visit two, re-drafted.' } as never)
      .catch(() => undefined);

    expect(contextItemRepository.create).not.toHaveBeenCalled();
    expect(contextItemRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect((contextItemRepository.updateWithVersion.mock.calls[0] as unknown[])[0]).toBe('note-enc-2');
  });

  it('a pre-encounter (unstamped) draft counts as encounter 1: updated in encounter 1, left alone in encounter 2', async () => {
    const first = build(1, [draftRow('note-legacy', null, 'Legacy note.')]);
    await first.service
      .persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'Legacy note, re-drafted.' } as never)
      .catch(() => undefined);
    expect(first.contextItemRepository.create).not.toHaveBeenCalled();
    expect((first.contextItemRepository.updateWithVersion.mock.calls[0] as unknown[])[0]).toBe('note-legacy');

    const second = build(2, [draftRow('note-legacy', null, 'Legacy note.')]);
    await second.service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'Visit two.' } as never).catch(() => undefined);
    expect(second.contextItemRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(second.contextItemRepository.create).toHaveBeenCalledTimes(1);
  });
});
