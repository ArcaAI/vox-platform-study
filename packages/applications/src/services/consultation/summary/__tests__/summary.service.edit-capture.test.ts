/**
 * (S5) — DNA edit-capture on the SummaryService edit/sign path.
 *
 *  - S4 (the immutable AI-draft v1 snapshot, changeReason='ai_draft_v1') is
 *    written by the harness draft persist (`HarnessInternalService.persistDraft`)
 *    and pinned in its own suite; the synchronous `generateSummary` that also
 *    wrote one was removed (TASK-1006).
 *  - S5: `updateSummary` stamps the edit delta (contentDiff + fieldChanges) onto
 *    the new version; `approveSummary` stamps the cumulative AI-draft→approved
 *    delta onto the signed note (read against the v1 baseline).
 *
 * No schema change — `ContextItemVersion.{contentDiff,fieldChanges}` already exist.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { wireSessionApproval } from './session-approval.fixture';
import { ConsultationEntity } from '@arcaai/domains';

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
    // `updateSummary`/`approveSummary` now write through the
    // OCC-aware Compare-And-Set variant.
    updateWithVersion: vi.fn(async (_id: string, e: unknown, _expectedVersion?: number, _tx?: unknown) => e),
  },
  consultationRepository: {
    // approveSummary calls the real ConsultationEntity.transitionTo.
    findById: vi.fn().mockResolvedValue(
      new ConsultationEntity({
        id: 'c-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        departmentId: null,
        doctorId: 'doctor-1',
        parentConsultationId: null,
        appointmentDate: new Date('2026-01-01'),
        metadata: null,
        degradedReasons: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        createdBy: 'user-1',
        status: 'STOPPED',
        version: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ),
    update: vi.fn(async (_id: string, e: unknown) => e),
    // `approveSummary` now CASes the Consultation row too.
    updateWithVersion: vi.fn(async (_id: string, e: unknown, _expectedVersion?: number, _tx?: unknown) => e),
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
  harnessPolicy: { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma' }) },
});

const build = (m: ReturnType<typeof makeMocks>) => {
  const service = new SummaryService(
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
  );
  // approveSummary delegates to the session approve; wire the real one behind ModuleRef.
  wireSessionApproval(service);
  return service;
};

describe('SummaryService — DNA edit-capture (Phase 6)', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: SummaryService;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
    service = build(m);
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
