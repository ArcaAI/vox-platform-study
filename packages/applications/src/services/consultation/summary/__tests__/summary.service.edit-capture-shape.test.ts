/**
 * carry-over A — the FINAL-summary edit-capture plane is shape-driven.
 *
 * `content-diff.util.ts` no longer owns a private four-key SOAP tuple; the
 * section vocabulary arrives as a compiled document template. This suite proves
 * the other half: that `SummaryService` actually RESOLVES the tenant's pinned
 * shape and hands it to `diffContent` on both write paths (clinician edit and
 * sign-off), so a tenant whose template is a discharge summary gets its own
 * section keys in `ContextItemVersion.fieldChanges`.
 *
 * Without this wiring the util's no-shape branch would apply everywhere and
 * every note — SOAP included — would silently degrade to a whole-document
 * delta. `summary.service.edit-capture.test.ts` covers exactly that unwired
 * case (its fixtures pass no template service), so the two suites together pin
 * both branches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { ConsultationEntity } from '@arcaai/domains';
import { compileDocumentTemplate } from '../../../document-template/document-template-compiler';
import { SOAP_NOTE_SHAPE } from '../../../document-template/platform-document-shapes';
import type { DocumentTemplateShape } from '../../../document-template/document-template-shape';

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

/** A five-section, non-SOAP tenant shape — the case that used to be inexpressible. */
const DISCHARGE_SHAPE: DocumentTemplateShape = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [
    { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE' },
    { key: 'hospital_course', title: 'Hospital Course', form: 'PROSE' },
    { key: 'discharge_medications', title: 'Discharge Medications', form: 'BULLETS' },
    { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
    { key: 'red_flags', title: 'Red Flags', form: 'PROSE' },
  ],
};

const dischargeNote = (course: string): string =>
  ['Reason for Admission:', 'Chest pain.', 'Hospital Course:', course, 'Follow-up:', 'GP in 2 weeks.'].join('\n');

const soapNote = (subjective: string): string =>
  ['Subjective:', subjective, 'Objective:', 'BP 120/80.', 'Assessment:', 'Tension headache.', 'Plan:', 'Rest and fluids.'].join('\n');

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
    updateWithVersion: vi.fn(async (_id: string, e: unknown, _expectedVersion?: number, _tx?: unknown) => e),
  },
  consultationRepository: {
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
        status: 'PENDING_REVIEW',
        version: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ),
    update: vi.fn(async (_id: string, e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown, _expectedVersion?: number, _tx?: unknown) => e),
  },
  summaryMetaRepository: { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), findByContextItem: vi.fn().mockResolvedValue(null) },
  namedEntityRepository: { create: vi.fn() },
  httpService: { axiosRef: { post: vi.fn() } },
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

/** A stand-in `IDocumentTemplateService` that resolves one fixed shape. */
const templateService = (shape: DocumentTemplateShape) => ({
  resolveForGeneration: vi.fn().mockResolvedValue({
    templateId: 'tpl-1',
    slug: 'tenant_shape',
    versionNumber: 3,
    documentTemplateVersionId: 'ver-3',
    compiled: compileDocumentTemplate(shape),
  }),
});

const build = (m: ReturnType<typeof makeMocks>, docTemplates?: unknown) =>
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
    undefined, // configResolver
    undefined, // entitlements
    undefined, // trajectoryService
    undefined, // aiTaskDefaultService
    undefined, // transcriptSegmentRepository
    undefined, // usageLedger
    undefined, // unitOfWork
    undefined, // billing
    undefined, // aiModelRepository
    undefined, // noteGenerationService
    undefined, // phiRedactor
    undefined, // gateEditMiningQueue
    undefined, // textRequestEnrichment
    docTemplates as any, // documentTemplateService
  );

const draftItem = (content: string) => ({
  id: 'ctx-1',
  tenantId: 'tenant-1',
  consultationId: 'c-1',
  type: 'RAW_SUMMARY',
  content,
  isSummary: true,
  isFinalSummary: true,
  currentVersionNumber: 1,
  updatedBy: null as string | null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  toObject: vi.fn().mockReturnValue({}),
  changes: {},
});

describe('SummaryService — shape-driven edit capture (carry-over A)', () => {
  let m: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  describe('updateSummary', () => {
    it("keys fieldChanges on the TENANT's five-section shape, not on SOAP", async () => {
      const docTemplates = templateService(DISCHARGE_SHAPE);
      const service = build(m, docTemplates);
      m.contextItemRepository.findById.mockResolvedValue(draftItem(dischargeNote('Troponin negative.')));

      await service.updateSummary('ctx-1', { content: dischargeNote('Troponin negative; serial ECGs unchanged.') } as any);

      // Placement guard: if the injected mock landed in the wrong constructor
      // slot this call never happens and the assertion below is meaningless.
      expect(docTemplates.resolveForGeneration).toHaveBeenCalledWith('tenant-1');

      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.fieldChanges).toEqual({
        hospital_course: { old: 'Troponin negative.', new: 'Troponin negative; serial ECGs unchanged.' },
      });
    });

    it('still produces per-section changes for a tenant on the platform SOAP shape', async () => {
      const service = build(m, templateService(SOAP_NOTE_SHAPE));
      m.contextItemRepository.findById.mockResolvedValue(draftItem(soapNote('Patient reports headache.')));

      await service.updateSummary('ctx-1', { content: soapNote('Patient reports severe headache.') } as any);

      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.fieldChanges).toEqual({
        subjective: { old: 'Patient reports headache.', new: 'Patient reports severe headache.' },
      });
    });

    it('never resolves a template for a metadata-only edit (nothing to diff)', async () => {
      const docTemplates = templateService(SOAP_NOTE_SHAPE);
      const service = build(m, docTemplates);
      m.contextItemRepository.findById.mockResolvedValue(draftItem(soapNote('Patient reports headache.')));

      await service.updateSummary('ctx-1', { changeReason: 'reclassify' } as any);

      expect(docTemplates.resolveForGeneration).not.toHaveBeenCalled();
      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.fieldChanges).toBeNull();
    });

    it('degrades to the whole-document delta when template resolution throws', async () => {
      // A diff is enrichment, never a precondition: an edit must not fail
      // because the template catalog is unreachable.
      const docTemplates = { resolveForGeneration: vi.fn().mockRejectedValue(new Error('catalog down')) };
      const service = build(m, docTemplates);
      const before = soapNote('Patient reports headache.');
      const after = soapNote('Patient reports severe headache.');
      m.contextItemRepository.findById.mockResolvedValue(draftItem(before));

      await service.updateSummary('ctx-1', { content: after } as any);

      const version = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(version.fieldChanges).toEqual({ document: { old: before, new: after } });
    });
  });

  describe('approveSummary', () => {
    it("keys the signed note's cumulative delta on the tenant's shape", async () => {
      const docTemplates = templateService(DISCHARGE_SHAPE);
      const service = build(m, docTemplates);
      m.contextItemRepository.findById.mockResolvedValue(draftItem(dischargeNote('Troponin negative; serial ECGs unchanged.')));
      m.contextItemVersionRepository.getVersionsByChangeReason.mockImplementation(async (_id: string, reason: string) =>
        reason === 'ai_draft_v1' ? [{ content: dischargeNote('Troponin negative.') }] : [],
      );

      await service.approveSummary('ctx-1');

      expect(docTemplates.resolveForGeneration).toHaveBeenCalledWith('tenant-1');

      const signed = m.contextItemVersionRepository.create.mock.calls[0][0];
      expect(signed.fieldChanges).toEqual({
        hospital_course: { old: 'Troponin negative.', new: 'Troponin negative; serial ECGs unchanged.' },
      });
    });
  });
});
