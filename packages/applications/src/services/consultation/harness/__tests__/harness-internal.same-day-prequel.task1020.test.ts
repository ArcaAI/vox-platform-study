/**
 * TASK-1020 — the durable finalize (`HarnessInternalService.assemble`) carries the same-day prequel
 * and the client's lab results; and a PROBE of `persistDraft` against a signed note.
 *
 * ## assemble
 *
 * The prequel is produced UNCONDITIONALLY whenever a same-day ancestor exists — it does not ride
 * the graph's `carryForward` binding, which keeps governing `prior_visit_summary` exactly as before.
 *
 * ## persistDraft probe (TASK-1020 §8, "persistDraft adopting a RAW_SUMMARY with no approval check")
 *
 * `HarnessDocWorkflow` can run a second execution for the same consultation, and `persistDraft`
 * ADOPTS its own prior RAW_SUMMARY row. The question this probe answers: does a late re-delivery
 * overwrite a note the clinician has already APPROVED (an `approved` ContextItemVersion exists and
 * the consultation is SIGNED)? Signed documentation is immutable (BP-2), so it must not.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';

import { HarnessInternalService } from '../harness-internal.service';

const TENANT = 'tenant-1020';
const CID = 'consultation-afternoon';
const PARENT = 'consultation-morning';
const PATIENT = 'patient-1020';
const DAY = new Date('2026-09-29T00:00:00.000Z');

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function consultation(overrides: Record<string, unknown>): ConsultationEntity {
  return new ConsultationEntity({
    tenantId: TENANT,
    patientId: PATIENT,
    appointmentDate: DAY,
    doctorId: 'doctor-1',
    departmentId: 'dept-1',
    metadata: null,
    degradedReasons: [],
    createdAt: new Date('2026-09-29T09:30:00.000Z'),
    updatedAt: new Date('2026-09-29T09:30:00.000Z'),
    createdBy: 'user-1',
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 1,
    ...overrides,
  } as never);
}

interface Wiring {
  child?: Record<string, unknown>;
  parent?: Record<string, unknown> | null;
  parentNotes?: Partial<Record<ContextItemType, Array<{ content: string; createdAt: Date }>>>;
  investigations?: unknown;
  carryForward?: boolean;
  /** RAW_SUMMARY rows of the consultation itself (the harness's own prior draft). */
  ownDrafts?: Array<Record<string, unknown>>;
  approvedVersions?: unknown[];
}

function build(wiring: Wiring = {}) {
  const child = consultation({ id: CID, parentConsultationId: PARENT, status: ConsultationStatus.RECORDING, ...wiring.child });
  const parent =
    wiring.parent === null
      ? null
      : consultation({ id: PARENT, status: ConsultationStatus.SIGNED, createdAt: new Date('2026-09-29T04:15:00.000Z'), ...wiring.parent });

  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([{ id: 'tx-1', content: 'Patient returns with the lab results.' }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findWorknotes: vi.fn().mockResolvedValue([]),
    findAttachments: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findByType: vi.fn(async (consultationId: string, type: ContextItemType) => {
      if (consultationId === PARENT) return wiring.parentNotes?.[type] ?? [];
      if (consultationId === CID && type === ContextItemType.RAW_SUMMARY) return wiring.ownDrafts ?? [];
      return [];
    }),
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) =>
      kindKey === 'investigations' && wiring.investigations !== undefined
        ? { id: 'ci-inv', kindKey, content: JSON.stringify(wiring.investigations), createdAt: new Date() }
        : null,
    ),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: Record<string, unknown>) => ({ ...entity, id: 'ctx-new' })),
    update: vi.fn(async (id: string, entity: Record<string, unknown>) => ({ ...entity, id })),
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>) => ({ ...entity, id })),
    encryptContentIntoEntity: vi.fn(),
  };

  const consultationRepository = {
    findById: vi.fn(async (id: string) => {
      if (id === CID) return child;
      if (id === PARENT && parent) return parent;
      throw new Error('DataNotFound');
    }),
    update: vi.fn(),
    updateWithVersion: vi.fn(async () => ({ id: CID })),
  };

  const summaryMetaRepository = {
    findByContextItem: vi.fn(async () => ({ id: 'sm-1', version: 1 })),
    update: vi.fn(),
    updateWithVersion: vi.fn(async () => ({ id: 'sm-1' })),
    encryptFieldsIntoEntity: vi.fn(),
    create: vi.fn(async () => ({ id: 'sm-new' })),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({
      userPrompt: 'prompt',
      systemPrompt: 'system',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'department',
      promptId: 'tpl-1',
      resolvedVersionNumber: 2,
    }),
  };
  const configResolver = {
    resolveRevisitCarryForwardEnabled: vi.fn(async () => wiring.carryForward ?? false),
    resolvePreferredPromptTemplateId: vi.fn(async () => null),
    resolveEffectiveDnaStyleEnabled: vi.fn(async () => ({ effective: false, tenantEnabled: false, doctorToggle: null })),
  };
  const contextItemVersionRepository = {
    create: vi.fn(async () => ({ id: 'ver-1' })),
    encryptFieldsIntoEntity: vi.fn(),
    getVersionsByChangeReason: vi.fn(async () => wiring.approvedVersions ?? []),
  };

  const service = new HarnessInternalService(
    contextItemRepository as never,
    consultationRepository as never,
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) } as never,
    summaryMetaRepository as never,
    promptAssemblyService as never,
    { findById: vi.fn().mockResolvedValue({ id: 'tpl-1', currentVersionNumber: 3 }) } as never,
    { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) } as never,
    createMockCls() as never,
    undefined, // jobService
    undefined, // highlightRepository
    { publishComplete: vi.fn().mockResolvedValue({ ok: true }) } as never, // assuranceService
    configResolver as never,
    contextItemVersionRepository as never,
    undefined, // secretsService
    undefined, // redisCache
    undefined, // transcriptSegmentRepository
    undefined, // harnessPolicyService
    undefined, // mcpServerRepository
  );

  return { service, contextItemRepository, consultationRepository, summaryMetaRepository, promptAssemblyService, contextItemVersionRepository };
}

const assembleDto = { tenantId: TENANT, userId: 'user-1', conversationLanguage: 'en' } as never;
const paramsOf = (assemble: ReturnType<typeof vi.fn>) => assemble.mock.calls[0][0] as Record<string, unknown>;

describe('TASK-1020 — HarnessInternalService.assemble carries the same-day prequel', () => {
  it('passes the morning note as sameDayPrequelSummary — even with carryForward OFF', async () => {
    const { service, promptAssemblyService } = build({
      carryForward: false,
      parentNotes: { [ContextItemType.SIGNED_NOTE]: [{ content: 'MORNING-SIGNED plan: CBC', createdAt: new Date() }] },
    });

    await service.assemble(CID, assembleDto);

    const params = paramsOf(promptAssemblyService.assemble);
    expect(params.sameDayPrequelSummary).toBe('### Earlier visit today (04:15 UTC, status SIGNED)\nMORNING-SIGNED plan: CBC');
    // carryForward still governs prior_visit_summary exactly as before.
    expect(params).not.toHaveProperty('priorVisitSummary');
  });

  it('omits the key entirely for a parent from another day', async () => {
    const { service, promptAssemblyService } = build({
      parent: { appointmentDate: new Date('2026-09-01T00:00:00.000Z') },
      parentNotes: { [ContextItemType.SIGNED_NOTE]: [{ content: 'OLD', createdAt: new Date() }] },
    });

    await service.assemble(CID, assembleDto);

    expect(paramsOf(promptAssemblyService.assemble)).not.toHaveProperty('sameDayPrequelSummary');
  });

  it('omits the key for a first visit and reads no parent', async () => {
    const { service, promptAssemblyService, consultationRepository } = build({ child: { parentConsultationId: null } });

    await service.assemble(CID, assembleDto);

    expect(paramsOf(promptAssemblyService.assemble)).not.toHaveProperty('sameDayPrequelSummary');
    expect(consultationRepository.findById).toHaveBeenCalledTimes(1);
  });

  it('passes the client’s investigations as testResults', async () => {
    const { service, promptAssemblyService } = build({
      child: { parentConsultationId: null },
      investigations: { results: [{ name: 'Haemoglobin', value: '10.2', unit: 'g/dL', flag: 'L' }] },
    });

    await service.assemble(CID, assembleDto);

    expect(paramsOf(promptAssemblyService.assemble).testResults).toBe('- Haemoglobin: 10.2 g/dL [L]');
  });

  it('omits testResults when the client sent none', async () => {
    const { service, promptAssemblyService } = build({ child: { parentConsultationId: null } });

    await service.assemble(CID, assembleDto);

    expect(paramsOf(promptAssemblyService.assemble)).not.toHaveProperty('testResults');
  });
});

describe('TASK-1020 probe — persistDraft never overwrites an APPROVED (signed) note', () => {
  const draftDto = {
    tenantId: TENANT,
    userId: 'harness',
    content: 'LATE RE-DELIVERY — regenerated note',
    modelName: 'm',
    modelVersion: 'v',
  } as never;
  const ownDraft = () => [
    {
      id: 'ctx-draft-1',
      version: 4,
      content: 'THE SIGNED NOTE',
      metaData: { subType: 'HARNESS_DRAFT' },
      createdAt: new Date('2026-09-29T05:00:00.000Z'),
    },
  ];

  it('leaves the signed note untouched when the consultation is SIGNED and the note has an approved version', async () => {
    const { service, contextItemRepository, summaryMetaRepository } = build({
      child: { parentConsultationId: null, status: ConsultationStatus.SIGNED },
      ownDrafts: ownDraft(),
      approvedVersions: [{ id: 'ver-approved', changeReason: 'approved' }],
    });

    await service.persistDraft(CID, draftDto);

    expect(contextItemRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
    expect(contextItemRepository.create).not.toHaveBeenCalled();
    // …nor re-stamps the signed note's SummaryMeta with a run whose content was not applied.
    expect(summaryMetaRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('refuses adoption on an approved version alone (status already moved on, e.g. CLOSED_INCOMPLETE)', async () => {
    const { service, contextItemRepository } = build({
      child: { parentConsultationId: null, status: ConsultationStatus.CLOSED_INCOMPLETE },
      ownDrafts: ownDraft(),
      approvedVersions: [{ id: 'ver-approved', changeReason: 'approved' }],
    });

    await service.persistDraft(CID, draftDto);

    expect(contextItemRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('still adopts (updates in place) an UNAPPROVED draft — the existing re-delivery contract', async () => {
    const { service, contextItemRepository } = build({
      child: { parentConsultationId: null, status: ConsultationStatus.DRAINING },
      ownDrafts: ownDraft(),
      approvedVersions: [],
    });

    await service.persistDraft(CID, draftDto);

    expect(contextItemRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    const [, entity] = contextItemRepository.updateWithVersion.mock.calls[0]!;
    expect((entity as { content?: string }).content).toBe('LATE RE-DELIVERY — regenerated note');
  });
});

describe('TASK-1022 — a skipped adoption is never logged as "Harness draft persisted"', () => {
  // Measured (TASK-1020 replay run 3, C1, 09:22:05): "adoption skipped — already approved" was
  // followed by "Harness draft persisted WITHOUT advancing…" and then "Harness draft persisted" for
  // the SAME request, although no note content was written.
  const draftDto = { tenantId: TENANT, userId: 'harness', content: 'LATE RE-DELIVERY', modelName: 'm', modelVersion: 'v' } as never;
  const ownDraft = () => [
    { id: 'ctx-draft-1', version: 4, content: 'THE SIGNED NOTE', metaData: { subType: 'HARNESS_DRAFT' }, createdAt: new Date('2026-09-29T05:00:00.000Z') },
  ];
  const messagesOf = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map(([entry]) => (typeof entry === 'object' && entry !== null ? String((entry as { message?: unknown }).message) : String(entry)));

  it('logs the delivery as NOT applied when adoption was refused (signed note)', async () => {
    const { service } = build({
      child: { parentConsultationId: null, status: ConsultationStatus.CLOSED_COMPLETE },
      ownDrafts: ownDraft(),
      approvedVersions: [{ id: 'ver-approved', changeReason: 'approved' }],
    });
    const logger = (service as unknown as { logger: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } }).logger;
    const log = vi.spyOn(logger, 'log');
    const warn = vi.spyOn(logger, 'warn');

    await service.persistDraft(CID, draftDto);

    const all = [...messagesOf(log), ...messagesOf(warn)];
    expect(all.some((m) => m.startsWith('Harness draft persisted'))).toBe(false);
    const final = log.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(final.message).toBe('Harness draft delivery recorded — the note content was NOT applied (adoption skipped)');
    expect(final.adoptionSkipped).toBe('approved');
  });

  it('keeps "Harness draft persisted" when the content WAS applied (adoption of an unapproved draft)', async () => {
    const { service } = build({
      child: { parentConsultationId: null, status: ConsultationStatus.DRAINING },
      ownDrafts: ownDraft(),
      approvedVersions: [],
    });
    const log = vi.spyOn((service as unknown as { logger: { log: (...a: unknown[]) => void } }).logger, 'log');

    await service.persistDraft(CID, draftDto);

    const final = log.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(final.message).toBe('Harness draft persisted');
    expect(final).not.toHaveProperty('adoptionSkipped');
  });
});
