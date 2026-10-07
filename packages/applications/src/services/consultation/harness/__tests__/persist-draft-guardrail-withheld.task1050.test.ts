/**
 * TASK-1050 W2e — an OUTBOUND-blocked generation is never stored as an ordinary note (README §9.7.6,
 * OD-19). `persistDraft` with `guardrailWithheld` creates a WITHHELD placeholder: no content, no
 * ciphertext, no SummaryMeta, never adopted as the harness draft. The withheld text lives only
 * encrypted on its `GuardrailEvaluation` row.
 *
 * And the harness assemble path leaves a WITHHELD item, or a BLOCKED one its hold excluded, out of
 * the prompt it builds (README §9.7.5).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, GuardrailItemStatus, ResourceStatusType } from '@arcaai/domains';
import { HarnessInternalService } from '../harness-internal.service';
import { HarnessDraftRequest } from '../dto';
import { GUARDRAIL_WITHHELD_SUBTYPE } from '../harness-draft.constants';

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
    metadata: null,
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

function build(items: Array<Record<string, unknown>> = [], excludedItemIds: string[] = []) {
  const contextItemRepository = {
    findTranscripts: vi.fn(async () => items.filter((i) => i.type === ContextItemType.TRANSCRIPT)),
    findCaseNotes: vi.fn(async () => items.filter((i) => i.type === ContextItemType.CASE_NOTE)),
    findWorknotes: vi.fn(async () => []),
    findAttachments: vi.fn(async () => []),
    findByType: vi.fn(async () => []),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: Record<string, unknown>) => entity),
    updateWithVersion: vi.fn(),
    encryptContentIntoEntity: vi.fn(),
  };
  const summaryMetaRepository = { findByContextItem: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn(), encryptFieldsIntoEntity: vi.fn() };
  const promptAssemblyService = { assemble: vi.fn(async () => ({ systemPrompt: 'S', userPrompt: 'U' })) };
  const lifecycleGate = { assertContentWritable: vi.fn(), setProcessing: vi.fn() };
  const guardrailNotices = { findAll: vi.fn(async () => (excludedItemIds.length ? [{ itemIds: excludedItemIds }] : [])) };
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

describe('HarnessDraftRequest.guardrailWithheld', () => {
  it('is accepted by the strict pipe and requires a noticeId', async () => {
    const ok = plainToInstance(HarnessDraftRequest, { tenantId: TENANT, content: '', guardrailWithheld: { noticeId: 'n-1', evaluationId: 'e-1' } });
    expect(await validate(ok, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).toEqual([]);
    const bad = plainToInstance(HarnessDraftRequest, { tenantId: TENANT, content: '', guardrailWithheld: { evaluationId: 'e-1' } });
    expect((await validate(bad, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
  });
});

describe('persistDraft — an outbound-blocked generation', () => {
  it('creates a WITHHELD placeholder with no content and no SummaryMeta', async () => {
    const { service, contextItemRepository, summaryMetaRepository } = build();
    const response = await service.persistDraft(CID, {
      tenantId: TENANT,
      userId: 'harness',
      content: 'THE WITHHELD NOTE MUST NOT BE STORED',
      guardrailWithheld: { noticeId: 'n-1', evaluationId: 'e-1' },
    } as never);

    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
    const [placeholder] = contextItemRepository.create.mock.calls[0] as unknown as [Record<string, unknown> & { metaData: Record<string, unknown> }];
    expect(placeholder.guardrailStatus).toBe(GuardrailItemStatus.WITHHELD);
    expect(placeholder.type).toBe(ContextItemType.RAW_SUMMARY);
    expect(placeholder.content ?? '').toBe('');
    expect(placeholder.encryptedContent ?? null).toBeNull();
    expect(placeholder.metaData).toMatchObject({ subType: GUARDRAIL_WITHHELD_SUBTYPE, guardrail: { noticeId: 'n-1', evaluationId: 'e-1' } });
    expect(JSON.stringify(contextItemRepository.create.mock.calls)).not.toContain('THE WITHHELD NOTE');
    expect(contextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
    expect(summaryMetaRepository.create).not.toHaveBeenCalled();
    expect(response.contextItemId).toBe(placeholder.id);
  });
});

describe('assemble — guardrail exclusion', () => {
  it('leaves WITHHELD and excluded BLOCKED items out of the assembled prompt', async () => {
    const items = [
      { id: 't-1', type: ContextItemType.TRANSCRIPT, content: 'clean transcript', guardrailStatus: 'CLEAN', createdAt: new Date() },
      { id: 't-2', type: ContextItemType.TRANSCRIPT, content: 'EXCLUDED-CANARY', guardrailStatus: 'BLOCKED', createdAt: new Date() },
      { id: 'n-1', type: ContextItemType.CASE_NOTE, content: 'WITHHELD-CANARY', guardrailStatus: 'WITHHELD', createdAt: new Date() },
      { id: 'n-2', type: ContextItemType.CASE_NOTE, content: 'kept case note', guardrailStatus: 'WARNED', createdAt: new Date() },
    ];
    const { service, promptAssemblyService } = build(items, ['t-2']);
    await service.assemble(CID, { tenantId: TENANT } as never).catch(() => undefined);
    const sent = JSON.stringify(promptAssemblyService.assemble.mock.calls);
    expect(promptAssemblyService.assemble).toHaveBeenCalled();
    expect(sent).toContain('clean transcript');
    expect(sent).toContain('kept case note');
    expect(sent).not.toContain('EXCLUDED-CANARY');
    expect(sent).not.toContain('WITHHELD-CANARY');
  });
});
