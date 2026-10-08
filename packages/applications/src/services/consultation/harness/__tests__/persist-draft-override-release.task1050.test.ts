/**
 * TASK-1050 follow-up F — a note RELEASED by an `acknowledged` override of an outbound block is
 * persisted later, by the paused node's re-run; `persistDraft` marks the new RAW_SUMMARY WARNED
 * right after creating it (`markOverrideReleasedItem`), scoped to the consultation's governing run.
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
    version: 3,
  } as never);
}

function build(notices: Array<Record<string, unknown>>) {
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

const acknowledgedOutboundBlock = (overrides: Record<string, unknown> = {}) => ({
  id: 'n-1',
  tenantId: TENANT,
  consultationId: CID,
  runId: 'run-1',
  type: 'BLOCKED',
  direction: 'OUTBOUND',
  status: 'RESOLVED',
  resolution: 'acknowledged',
  messageKey: 'guardrail.blocked.outbound',
  resolvedAt: new Date('2000-01-01T00:00:00Z'),
  ...overrides,
});

describe('persistDraft — an override-released note', () => {
  it('marks the RAW_SUMMARY it creates WARNED', async () => {
    const { service, contextItemRepository, guardrailNotices } = build([acknowledgedOutboundBlock()]);
    await service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'The released note.' } as never).catch(() => undefined);

    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [{ id: string }];
    expect(contextItemRepository.setGuardrailStatus).toHaveBeenCalledWith(created.id, 'WARNED', undefined);
    expect(guardrailNotices.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ consultationId: CID, resolution: 'acknowledged' }) }),
    );
  });

  it('an override of ANOTHER run does not mark it', async () => {
    const { service, contextItemRepository } = build([acknowledgedOutboundBlock({ runId: 'run-0' })]);
    await service.persistDraft(CID, { tenantId: TENANT, userId: 'harness', content: 'The note.' } as never).catch(() => undefined);
    expect(contextItemRepository.setGuardrailStatus).not.toHaveBeenCalled();
  });
});
