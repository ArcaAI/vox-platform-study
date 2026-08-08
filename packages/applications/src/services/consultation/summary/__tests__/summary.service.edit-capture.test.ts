/**
 * (S4 + S5) — DNA edit-capture on the sync SummaryService path.
 *
 *  - S4: `generateSummary` writes an immutable AI-draft v1 snapshot
 *    (`ContextItemVersion`, changeReason='ai_draft_v1', changeSource='ai_model')
 *    and pins the item to currentVersionNumber=1 so the first doctor edit becomes
 *    v2 (no version-number collision). The snapshot is best-effort.
 *  - S5: `updateSummary` stamps the edit delta (contentDiff + fieldChanges) onto
 *    the new version; `approveSummary` stamps the cumulative AI-draft→approved
 *    delta onto the signed note (read against the v1 baseline).
 *
 * No schema change — `ContextItemVersion.{contentDiff,fieldChanges}` already exist.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';

// Mock only the version factory (echo args) so we can assert the row written;
// keep the real ContextItemFactory + enums via `...actual`.
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      CreateFromContextItem: vi.fn((contextItem, versionNumber, changeReason, changedBy, changeSource, changeSummary) => ({
        id: 'ver-1',
        contextItemId: contextItem.id,
        versionNumber,
        content: contextItem.content,
        changeReason,
        changedBy,
        changeSource: changeSource ?? 'manual',
        changeSummary: changeSummary ?? null,
        contentDiff: null,
        fieldChanges: null,
        tenantId: contextItem.tenantId,
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
      })),
      CreateSignedNoteVersion: vi.fn((props) => ({
        id: 'signed-1',
        contextItemId: props.contextItemId,
        versionNumber: props.versionNumber,
        content: props.content ?? null,
        changeReason: props.changeReason ?? 'approved',
        changedBy: props.attestedBy,
        changeSource: 'attestation',
        contentDiff: null,
        fieldChanges: null,
        attestedBy: props.attestedBy,
        attestationHash: props.attestationHash,
        tenantId: props.tenantId,
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
      })),
    },
  };
});

const cls = () => ({
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'doctor-1' };
    return null;
  }),
  set: vi.fn(),
});

const makeMocks = () => ({
  contextItemRepository: {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript' }]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
    create: vi.fn(async (e: unknown) => e),
    update: vi.fn(async (_id: string, e: unknown) => e),
  },
  consultationRepository: {
    findById: vi.fn().mockResolvedValue({
      id: 'c-1',
      tenantId: 'tenant-1',
      departmentId: null,
      doctorId: 'doctor-1',
      parentConsultationId: null,
      status: 'PENDING_REVIEW',
    }),
    update: vi.fn(async (_id: string, e: unknown) => e),
  },
  summaryMetaRepository: { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), findByContextItem: vi.fn().mockResolvedValue(null) },
  namedEntityRepository: { create: vi.fn() },
  httpService: { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'AI DRAFT BODY', modelName: 'm' } }) } },
  configService: { get: vi.fn(() => undefined) },
  eventEmitter: { emit: vi.fn() },
  contextItemVersionRepository: {
    create: vi.fn(async (e: unknown) => e),
    getVersionsByChangeReason: vi.fn().mockResolvedValue([]),
  },
  promptAssembly: {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'p', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
  },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  harnessPolicy: { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) },
});

const build = (m: ReturnType<typeof makeMocks>, configResolver?: unknown) =>
  new SummaryService(
    m.contextItemRepository as any,
    m.consultationRepository as any,
    m.summaryMetaRepository as any,
    m.namedEntityRepository as any,
    m.httpService as any,
    m.configService as any,
    m.eventEmitter as any,
    cls() as any,
    m.contextItemVersionRepository as any,
    m.promptAssembly as any,
    undefined, // secretsService
    undefined, // userProfileRepository
    m.harnessAudit as any, // harnessAuditService
    undefined, // harnessGatewayService
    m.harnessPolicy as any, // harnessPolicyService
    configResolver as any, // configResolver
  );

describe('SummaryService — DNA edit-capture (Phase 6)', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: SummaryService;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
    service = build(m);
  });

  describe('generateSummary — AI-draft v1 snapshot (S4)', () => {
    it('writes exactly one ai_draft_v1 ContextItemVersion (v1, ai_model, draft content) and pins currentVersionNumber=1', async () => {
      await service.generateSummary('c-1', { transcription: 'transcript' } as any);

      expect(m.contextItemVersionRepository.create).toHaveBeenCalledTimes(1);
      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.versionNumber).toBe(1);
      expect(version.changeReason).toBe('ai_draft_v1');
      expect(version.changeSource).toBe('ai_model');
      expect(version.content).toBe('AI DRAFT BODY');

      // The created RAW_SUMMARY is pinned to v1 so the first doctor edit is v2.
      const createdItem = m.contextItemRepository.create.mock.calls[0][0];
      expect(createdItem.currentVersionNumber).toBe(1);
    });

    it('does not roll back the draft when the snapshot write fails (best-effort)', async () => {
      m.contextItemVersionRepository.create.mockRejectedValueOnce(new Error('db down'));

      const result = await service.generateSummary('c-1', { transcription: 'transcript' } as any);

      // The draft (RAW_SUMMARY + meta) is still committed and returned.
      expect(result).toBeTruthy();
      expect(m.summaryMetaRepository.create).toHaveBeenCalledTimes(1);
      expect(m.eventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('generateSummary — DNA-style application gating (S3, tenant AND doctor)', () => {
    it('applies the requested DNA style when effective (passes the id to prompt assembly + draft)', async () => {
      const configResolver = {
        resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null }),
      };
      service = build(m, configResolver);

      await service.generateSummary('c-1', { transcription: 'transcript', dnaStyleId: 'dna-1' } as any);

      expect(m.promptAssembly.assemble.mock.calls[0][0].dnaStyleId).toBe('dna-1');
    });

    it('drops the DNA style when NOT effective (opted out / tenant off) — undefined to prompt assembly', async () => {
      const configResolver = {
        resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false }),
      };
      service = build(m, configResolver);

      await service.generateSummary('c-1', { transcription: 'transcript', dnaStyleId: 'dna-1' } as any);

      expect(m.promptAssembly.assemble.mock.calls[0][0].dnaStyleId).toBeUndefined();
    });
  });

  describe('updateSummary — edit delta (S5)', () => {
    const draftItem = () => ({
      id: 'ctx-1',
      tenantId: 'tenant-1',
      consultationId: 'c-1',
      type: 'RAW_SUMMARY',
      content: 'AI DRAFT BODY',
      isSummary: true,
      currentVersionNumber: 1,
      updatedBy: null as string | null,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      toObject: vi.fn().mockReturnValue({}),
      changes: {},
    });

    it('stamps contentDiff + fieldChanges on the new version when content changes', async () => {
      m.contextItemRepository.findById.mockResolvedValue(draftItem());

      await service.updateSummary('ctx-1', { content: 'DOCTOR EDITED BODY' } as any);

      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.contentDiff).toContain('- AI DRAFT BODY');
      expect(version.contentDiff).toContain('+ DOCTOR EDITED BODY');
      expect(version.fieldChanges).toEqual({ document: { old: 'AI DRAFT BODY', new: 'DOCTOR EDITED BODY' } });
    });

    it('leaves contentDiff/fieldChanges null for a metadata-only edit (no content change)', async () => {
      m.contextItemRepository.findById.mockResolvedValue(draftItem());

      await service.updateSummary('ctx-1', { changeReason: 'reclassify' } as any);

      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.contentDiff).toBeNull();
      expect(version.fieldChanges).toBeNull();
    });
  });

  describe('approveSummary — draft→approved delta (S5)', () => {
    const finalItem = (content: string) => ({
      id: 'ctx-1',
      tenantId: 'tenant-1',
      consultationId: 'c-1',
      type: 'RAW_SUMMARY',
      content,
      isFinalSummary: true,
      isSummary: true,
      currentVersionNumber: 2,
      updatedBy: null as string | null,
      toObject: vi.fn().mockReturnValue({}),
      changes: {},
    });

    it('stamps the AI-draft→approved delta on the signed note even without an intermediate edit version', async () => {
      m.contextItemRepository.findById.mockResolvedValue(finalItem('DOCTOR FINAL BODY'));
      m.contextItemVersionRepository.getVersionsByChangeReason.mockImplementation(async (_id: string, reason: string) =>
        reason === 'ai_draft_v1' ? [{ content: 'AI DRAFT BODY' }] : [],
      );

      await service.approveSummary('ctx-1');

      const signed = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(signed.contentDiff).toContain('- AI DRAFT BODY');
      expect(signed.contentDiff).toContain('+ DOCTOR FINAL BODY');
      expect(signed.fieldChanges).toEqual({ document: { old: 'AI DRAFT BODY', new: 'DOCTOR FINAL BODY' } });
    });

    it('leaves the signed-note delta null when the doctor signs the draft unchanged', async () => {
      m.contextItemRepository.findById.mockResolvedValue(finalItem('AI DRAFT BODY'));
      m.contextItemVersionRepository.getVersionsByChangeReason.mockImplementation(async (_id: string, reason: string) =>
        reason === 'ai_draft_v1' ? [{ content: 'AI DRAFT BODY' }] : [],
      );

      await service.approveSummary('ctx-1');

      const signed = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(signed.contentDiff).toBeNull();
      expect(signed.fieldChanges).toBeNull();
    });
  });
});
