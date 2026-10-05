/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { wireSessionApproval } from './session-approval.fixture';
import { DNA_MEMORY_CAPTURE_EVENT } from '../../../dna-writing-style/dna-memory.events';
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

describe('SummaryService — TASK-1034 DNA memory capture hook', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: SummaryService;
  const item = (extra: Record<string, unknown> = {}) => ({
    id: 'ctx-1',
    tenantId: 'tenant-1',
    consultationId: 'c-1',
    type: 'RAW_SUMMARY',
    content: 'AI DRAFT BODY',
    isSummary: true,
    isFinalSummary: true,
    currentVersionNumber: 1,
    updatedBy: null as string | null,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    toObject: vi.fn().mockReturnValue({}),
    changes: {},
    ...extra,
  });
  const captureCalls = () => m.eventEmitter.emit.mock.calls.filter((c: unknown[]) => c[0] === DNA_MEMORY_CAPTURE_EVENT);

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
    service = build(m);
  });

  it('a content edit requests an EDIT capture after the commit', async () => {
    m.contextItemRepository.findById.mockResolvedValue(item());
    await service.updateSummary('ctx-1', { content: 'DOCTOR EDITED BODY' } as any);
    expect(captureCalls()).toEqual([
      [DNA_MEMORY_CAPTURE_EVENT, { tenantId: 'tenant-1', consultationId: 'c-1', contextItemId: 'ctx-1', source: 'EDIT' }],
    ]);
  });

  it('a metadata-only edit requests no capture', async () => {
    m.contextItemRepository.findById.mockResolvedValue(item());
    await service.updateSummary('ctx-1', { changeReason: 'reclassify' } as any);
    expect(captureCalls()).toEqual([]);
  });

  it('a sign-off requests a SIGNOFF capture', async () => {
    m.contextItemRepository.findById.mockResolvedValue(item());
    await service.approveSummary('ctx-1');
    expect(captureCalls()).toEqual([
      [DNA_MEMORY_CAPTURE_EVENT, { tenantId: 'tenant-1', consultationId: 'c-1', contextItemId: 'ctx-1', source: 'SIGNOFF' }],
    ]);
  });

  it('a throwing capture request never fails the sign-off', async () => {
    m.contextItemRepository.findById.mockResolvedValue(item());
    m.eventEmitter.emit.mockImplementation((name: string) => {
      if (name === DNA_MEMORY_CAPTURE_EVENT) throw new Error('listener exploded');
      return true;
    });
    await expect(service.approveSummary('ctx-1')).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
  });
});
