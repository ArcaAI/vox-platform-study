/**
 * The note belongs to the encounter it was written in: `persistDraft` stamps the RAW_SUMMARY it
 * creates — and the WITHHELD placeholder of an outbound-blocked generation — with the
 * consultation's current encounter.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';

const TENANT = '50000000-0000-0000-0000-000000000050';
const CID = '0199a000-0000-7000-8000-0000000000d1';

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function consultation(): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-07'),
    metadata: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-1', workflowDefinitionSlug: 'wf' } },
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.AWAITING_REVIEW,
    processingReason: 'GUARDRAIL_HOLD',
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-07'),
    updatedAt: new Date('2026-10-07'),
    createdBy: 'user-1',
    currentEncounterSeq: 2,
    version: 3,
  } as never);
}

function build(notices: Array<Record<string, unknown>> = []) {
  const items: Array<Record<string, unknown>> = [];
  const contextItemRepository = {
    findTranscripts: vi.fn(async () => items.filter((i) => i.type === ContextItemType.TRANSCRIPT)),
    findCaseNotes: vi.fn(async () => items.filter((i) => i.type === ContextItemType.CASE_NOTE)),
    findWorknotes: vi.fn(async () => []),
    findAttachments: vi.fn(async () => []),
    findByType: vi.fn(async () => []),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: Record<string, unknown>) => entity),
    setGuardrailStatus: vi.fn(async () => undefined),
    updateWithVersion: vi.fn(),
    encryptContentIntoEntity: vi.fn(),
  };
  const summaryMetaRepository = { findByContextItem: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn(), encryptFieldsIntoEntity: vi.fn() };
  const promptAssemblyService = { assemble: vi.fn(async () => ({ systemPrompt: 'S', userPrompt: 'U' })) };
  const lifecycleGate = { assertContentWritable: vi.fn(), setProcessing: vi.fn() };
  const guardrailNotices = { findAll: vi.fn(async () => notices) };
  const positional: unknown[] = [
    contextItemRepository,
    { findById: vi.fn(async () => consultation()) },
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) },
    summaryMetaRepository,
    promptAssemblyService,
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
  return { service, contextItemRepository, summaryMetaRepository, promptAssemblyService, guardrailNotices };
}

describe('persistDraft — the encounter the note was written in', () => {
  it('stamps a new harness draft with the consultation’s current encounter', async () => {
    const { service, contextItemRepository } = build();
    await service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'The note of visit two.' } as never).catch(() => undefined);

    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [{ type: string; encounterSeq: number | null }];
    expect(created.type).toBe(ContextItemType.RAW_SUMMARY);
    expect(created.encounterSeq).toBe(2);
  });

  it('stamps the WITHHELD placeholder of an outbound-blocked generation too', async () => {
    const { service, contextItemRepository } = build();
    await service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'blocked', guardrailWithheld: { noticeId: 'n-1' } } as never);

    const [placeholder] = contextItemRepository.create.mock.calls[0] as unknown as [{ type: string; encounterSeq: number | null }];
    expect(placeholder.type).toBe(ContextItemType.RAW_SUMMARY);
    expect(placeholder.encounterSeq).toBe(2);
  });
});
