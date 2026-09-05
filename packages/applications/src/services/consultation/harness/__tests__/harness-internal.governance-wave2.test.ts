/**
 * HarnessInternalService — governance behaviour.
 *
 *  * **F-18 re-visit carry-forward.** A consultation with a `parentConsultationId`
 *    may carry its prior visit's most authoritative note into the prompt — but
 *    only when `agentic.revisit.carryForwardEnabled` is on. The default-off case
 *    is asserted as a REGRESSION LOCK (nothing is fetched, nothing is passed),
 *    because carry-forward is the highest-risk context feature in the platform
 * (SOTA and must never switch on by deploy.
 *  * **F-11 SummaryMeta OCC.** The two-phase optimistic-delivery write
 *    (`persistDraft` EARLY → `finalizeAssurance` backfill) is a read-modify-write.
 *    Finalize must compare-and-set on `_version`, retry ONCE on drift (both phases
 *    are idempotent), and surface a persistent conflict rather than silently
 *    clobbering a concurrent write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultationStatus, ResourceStatusType } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { HarnessInternalService } from '../harness-internal.service';
import {
  AGENTIC_REVISIT_CARRY_FORWARD_KEY,
  PRIOR_VISIT_SUMMARY_MAX_CHARS,
  PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER,
} from '../../../settings-registry/descriptors/agentic-revisit.descriptors';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';
const PARENT = 'consultation-parent';

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

const contextItem = (id: string, type: string, content: string, createdAt = new Date('2026-07-01T00:00:00Z')) => ({
  id,
  type,
  content,
  createdAt,
  tenantId: TENANT,
});

interface Fixtures {
  carryForward?: boolean;
  parentConsultationId?: string | null;
  parentTenantId?: string;
  parentItems?: Record<string, unknown[]>;
}

function build(fixtures: Fixtures = {}) {
  const cls = createMockCls();

  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([{ id: 'tx-1', content: 'Patient reports chest pain.' }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findWorknotes: vi.fn().mockResolvedValue([]),
    findAttachments: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findByType: vi.fn(async (_consultationId: string, type: string) => (fixtures.parentItems?.[type] ?? []) as unknown[]),
    create: vi.fn(),
    encryptContentIntoEntity: vi.fn(),
    // `loadLiveSoapSnapshot` delegates to the repository's
    // `findLatestPreSummaryWithDecryptedContent`; mirror it here through this
    // fixture's own `findPreSummaries` mock (no SecretsService is wired in this
    // suite, so decrypt is never invoked — same as before the refactor).
    findLatestPreSummaryWithDecryptedContent: vi.fn(async (consultationId: string, secrets: unknown, options?: { subType?: string }) => {
      const preSummaries: Array<{ metaData?: unknown; createdAt: Date; content?: string | null }> = await contextItemRepository.findPreSummaries(
        consultationId,
      );
      const candidates = options?.subType
        ? preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
        : preSummaries;
      if (candidates.length === 0) return { entity: null, plaintext: null };
      const entity = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      const plaintext = secrets ? entity.content : (entity.content ?? null);
      return { entity, plaintext };
    }),
  };

  const consultationRepository = {
    findById: vi.fn(async (id: string) =>
      id === PARENT
        ? {
            id: PARENT,
            tenantId: fixtures.parentTenantId ?? TENANT,
            resourceStatus: ResourceStatusType.ENABLED,
          }
        : {
            id: CONSULTATION,
            tenantId: TENANT,
            departmentId: 'dept-1',
            doctorId: 'doctor-1',
            parentConsultationId: fixtures.parentConsultationId ?? null,
            status: ConsultationStatus.RECORDING,
            resourceStatus: ResourceStatusType.ENABLED,
          },
    ),
    update: vi.fn(),
  };

  const namedEntityRepository = { findByConsultation: vi.fn().mockResolvedValue([]) };
  const summaryMetaRepository = {
    findByContextItem: vi.fn(),
    update: vi.fn(),
    updateWithVersion: vi.fn(),
    encryptFieldsIntoEntity: vi.fn(),
    create: vi.fn(),
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
  const promptTemplateRepository = { findById: vi.fn().mockResolvedValue({ id: 'tpl-1', currentVersionNumber: 3 }) };
  const harnessAuditService = { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => ({
      key,
      tier: 'global-kv',
      value: key === AGENTIC_REVISIT_CARRY_FORWARD_KEY ? (fixtures.carryForward ?? false) : undefined,
      sourceScope: 'global-kv',
    })),
  };

  const service = new HarnessInternalService(
    contextItemRepository as never,
    consultationRepository as never,
    namedEntityRepository as never,
    summaryMetaRepository as never,
    promptAssemblyService as never,
    promptTemplateRepository as never,
    harnessAuditService as never,
    cls as never,
    undefined, // jobService
    undefined, // highlightRepository
    { publishComplete: vi.fn().mockResolvedValue({ ok: true }) } as never, // assuranceService
    undefined, // configResolver
    undefined, // contextItemVersionRepository
    undefined, // secretsService
    undefined, // redisCache
    undefined, // transcriptSegmentRepository
    undefined, // harnessPolicyService
    undefined, // mcpServerRepository
    effectiveSettings as never,
  );

  return { service, contextItemRepository, consultationRepository, summaryMetaRepository, promptAssemblyService, effectiveSettings };
}

const assembleDto = { tenantId: TENANT, userId: 'user-1', conversationLanguage: 'en' } as never;

describe('HarnessInternalService — re-visit carry-forward (F-18)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries nothing and reads no parent when the knob is OFF (regression lock)', async () => {
    const { service, promptAssemblyService, contextItemRepository } = build({ carryForward: false, parentConsultationId: PARENT });

    await service.assemble(CONSULTATION, assembleDto);

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.not.objectContaining({ priorVisitSummary: expect.anything() }));
    // The knob gates the READ too — a disabled feature must not cost a query.
    expect(contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('carries nothing for a NEW visit even when the knob is ON', async () => {
    const { service, promptAssemblyService, contextItemRepository } = build({ carryForward: true, parentConsultationId: null });

    await service.assemble(CONSULTATION, assembleDto);

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.not.objectContaining({ priorVisitSummary: expect.anything() }));
    expect(contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('prefers the parent SIGNED_NOTE over its summaries when the knob is ON', async () => {
    const { service, promptAssemblyService } = build({
      carryForward: true,
      parentConsultationId: PARENT,
      parentItems: {
        SIGNED_NOTE: [contextItem('c-signed', 'SIGNED_NOTE', 'SIGNED-MARKER final note')],
        MODIFIED_SUMMARY: [contextItem('c-mod', 'MODIFIED_SUMMARY', 'MODIFIED-MARKER')],
        RAW_SUMMARY: [contextItem('c-raw', 'RAW_SUMMARY', 'RAW-MARKER')],
      },
    });

    await service.assemble(CONSULTATION, assembleDto);

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ priorVisitSummary: 'SIGNED-MARKER final note' }));
  });

  it('falls back MODIFIED_SUMMARY → RAW_SUMMARY, newest first', async () => {
    const { service, promptAssemblyService } = build({
      carryForward: true,
      parentConsultationId: PARENT,
      parentItems: {
        MODIFIED_SUMMARY: [
          contextItem('c-mod-old', 'MODIFIED_SUMMARY', 'OLD-MARKER', new Date('2026-06-01T00:00:00Z')),
          contextItem('c-mod-new', 'MODIFIED_SUMMARY', 'NEW-MARKER', new Date('2026-07-01T00:00:00Z')),
        ],
        RAW_SUMMARY: [contextItem('c-raw', 'RAW_SUMMARY', 'RAW-MARKER')],
      },
    });

    await service.assemble(CONSULTATION, assembleDto);

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ priorVisitSummary: 'NEW-MARKER' }));
  });

  it('truncates an oversized prior-visit note at the cap with a marker', async () => {
    const { service, promptAssemblyService } = build({
      carryForward: true,
      parentConsultationId: PARENT,
      parentItems: { SIGNED_NOTE: [contextItem('c-signed', 'SIGNED_NOTE', 'y'.repeat(PRIOR_VISIT_SUMMARY_MAX_CHARS + 1_000))] },
    });

    await service.assemble(CONSULTATION, assembleDto);

    const carried = promptAssemblyService.assemble.mock.calls[0][0].priorVisitSummary as string;
    expect(carried.endsWith(PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER)).toBe(true);
    expect(carried.length).toBe(PRIOR_VISIT_SUMMARY_MAX_CHARS + PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER.length);
  });

  it('throws 404 (never 403) when the parent consultation belongs to another tenant', async () => {
    const { service } = build({ carryForward: true, parentConsultationId: PARENT, parentTenantId: 'tenant-OTHER' });

    await expect(service.assemble(CONSULTATION, assembleDto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('carries nothing (and does not fail) when the parent consultation was deleted', async () => {
    const { service, promptAssemblyService, consultationRepository } = build({ carryForward: true, parentConsultationId: PARENT });
    // Soft-deleted parents are filtered out by the client extension, so the
    // repository throws DataNotFoundException rather than returning a row.
    consultationRepository.findById.mockImplementation(async (id: string) => {
      if (id === PARENT) throw new Error('DataNotFound');
      return {
        id: CONSULTATION,
        tenantId: TENANT,
        parentConsultationId: PARENT,
        status: ConsultationStatus.RECORDING,
        resourceStatus: ResourceStatusType.ENABLED,
      };
    });

    await expect(service.assemble(CONSULTATION, assembleDto)).resolves.toBeDefined();
    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.not.objectContaining({ priorVisitSummary: expect.anything() }));
  });

  it('degrades to no carry-forward when the parent lookup fails (generation must not fail)', async () => {
    const { service, promptAssemblyService, contextItemRepository } = build({ carryForward: true, parentConsultationId: PARENT });
    contextItemRepository.findByType.mockRejectedValue(new Error('store down'));

    await expect(service.assemble(CONSULTATION, assembleDto)).resolves.toBeDefined();
    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.not.objectContaining({ priorVisitSummary: expect.anything() }));
  });
});

describe('HarnessInternalService — SummaryMeta OCC on finalize (F-11)', () => {
  const finalizeDto = {
    tenantId: TENANT,
    userId: 'user-1',
    contextItemId: 'ctx-draft-1',
    gateDecision: 'PASS',
    ragTriadScore: 0.9,
  } as never;

  const earlyMeta = (version: number) => ({
    id: 'sm-early-1',
    contextItemId: 'ctx-draft-1',
    version,
    ragTriadScore: null,
    citationsMap: null,
    guardrailDecisions: null,
    gateDecision: null,
    assuranceCompletedAt: null,
  });

  beforeEach(() => vi.clearAllMocks());

  it('compare-and-sets on the meta version instead of a blind update', async () => {
    const { service, summaryMetaRepository } = build();
    summaryMetaRepository.findByContextItem.mockResolvedValue(earlyMeta(1));
    summaryMetaRepository.updateWithVersion.mockResolvedValue({ id: 'sm-early-1' });

    await service.finalizeAssurance(CONSULTATION, finalizeDto);

    expect(summaryMetaRepository.updateWithVersion).toHaveBeenCalledWith('sm-early-1', expect.anything(), 1);
    expect(summaryMetaRepository.update).not.toHaveBeenCalled();
  });

  it('re-reads and retries ONCE when the version drifted under it', async () => {
    const { service, summaryMetaRepository } = build();
    summaryMetaRepository.findByContextItem.mockResolvedValueOnce(earlyMeta(1)).mockResolvedValueOnce(earlyMeta(2));
    summaryMetaRepository.updateWithVersion
      .mockRejectedValueOnce(new OptimisticConcurrencyException('summaryMeta', 'sm-early-1', { expectedVersion: 1, currentVersion: 2 }))
      .mockResolvedValueOnce({ id: 'sm-early-1' });

    await service.finalizeAssurance(CONSULTATION, finalizeDto);

    expect(summaryMetaRepository.findByContextItem).toHaveBeenCalledTimes(2);
    expect(summaryMetaRepository.updateWithVersion).toHaveBeenNthCalledWith(2, 'sm-early-1', expect.anything(), 2);
  });

  it('surfaces the conflict when the retry also loses the race', async () => {
    const { service, summaryMetaRepository } = build();
    summaryMetaRepository.findByContextItem.mockResolvedValue(earlyMeta(1));
    summaryMetaRepository.updateWithVersion.mockRejectedValue(
      new OptimisticConcurrencyException('summaryMeta', 'sm-early-1', { expectedVersion: 1, currentVersion: 9 }),
    );

    await expect(service.finalizeAssurance(CONSULTATION, finalizeDto)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(summaryMetaRepository.updateWithVersion).toHaveBeenCalledTimes(2);
  });
});
