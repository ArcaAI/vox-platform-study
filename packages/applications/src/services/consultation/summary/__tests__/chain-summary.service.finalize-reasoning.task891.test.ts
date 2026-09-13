/**
 * TASK-891 (finalize tier) — ChainSummaryService (comprehensive summary) must carry the resolved
 * agent's reasoning posture onto the wire, exactly as the live tier already does.
 *
 * `callTextService` resolves `{ provider, model, generation }` via
 * `HarnessPolicyService.resolveTextSelection(tenantId, 'finalize')` and then called
 * `applyTextRuntimeProfile(textPayload)` with NO second argument — the agent's
 * `parameters.generation.reasoning` block never reached the `extra` ride-along.
 *
 * The REAL `TextRequestEnrichmentService` is used (not a double): the claim under test is about
 * the body that service builds, so a stub would assert nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChainSummaryService } from '../chain-summary.service';
import { TextRequestEnrichmentService } from '../../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemFactory: {
      CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaStyleId, createdBy) => ({
        id: 'ctx-comprehensive-1',
        tenantId,
        consultationId,
        content,
        dnaWritingStyleId: dnaStyleId,
        type: 'RAW_SUMMARY',
        createdBy,
        createdAt: new Date('2026-02-17T10:00:00Z'),
        updatedAt: new Date('2026-02-17T10:00:00Z'),
      })),
    },
    SummaryMetaFactory: { CreateSummaryMeta: vi.fn((props) => ({ id: 'meta-1', ...props })) },
  };
});

const createConsultation = () => ({
  id: 'consultation-A',
  tenantId: TENANT,
  patientId: 'patient-1',
  doctorId: 'doctor-A',
  departmentId: 'dept-general',
  appointmentDate: new Date('2026-02-17'),
  parentConsultationId: null,
  metadata: null,
  Doctor: { username: 'Dr. A' },
  Department: { name: 'General Medicine' },
});

/** The REAL enrichment service — a stubbed one would assert nothing about the body it builds. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildService(generation: Record<string, unknown>) {
  const contextItemRepo = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findSummaries: vi.fn().mockResolvedValue([{ id: 'ctx-1', consultationId: 'consultation-A', type: 'RAW_SUMMARY', content: 'Findings.' }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findSharedContext: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation((item) => Promise.resolve(item)),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const consultation = createConsultation();
  const consultationRepo = {
    findById: vi.fn().mockResolvedValue(consultation),
    findConsultationChain: vi.fn().mockResolvedValue([consultation]),
    findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
  };
  const summaryMetaRepo = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }) };
  const namedEntityRepo = { findByContextItem: vi.fn().mockResolvedValue([]) };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'Result.' } }) } };
  const configService = { get: vi.fn().mockImplementation((key: string) => (key === 'TEXT_URL' ? 'http://text:8862' : null)) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn().mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'doctor-A' } : null)),
    set: vi.fn(),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'assembled', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
  };
  const harnessPolicyService = {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma', generation }),
  };

  const service = new ChainSummaryService(
    contextItemRepo as any,
    consultationRepo as any,
    summaryMetaRepo as any,
    namedEntityRepo as any,
    httpService as any,
    configService as any,
    eventEmitter as any,
    clsService as any,
    promptAssemblyService as any,
    undefined, // secretsService
    harnessPolicyService as any,
    undefined, // configResolver
    undefined, // usageLedger
    undefined, // unitOfWork
    undefined, // noteGenerationService
    enrichment() as any, // textRequestEnrichment — REAL
  );

  return { service, httpService };
}

const lastPostBody = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-891 — ChainSummaryService (comprehensive finalize) carries the resolved agent`s reasoning posture', () => {
  it('an agent that disabled reasoning instructs the engine not to reason', async () => {
    const { service, httpService } = buildService({ temperature: 0.1, reasoning: { enabled: false } });

    await service.generateComprehensiveSummary('consultation-A', { includeNER: false });

    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: false });
  });

  it('an agent that named an effort sends that effort', async () => {
    const { service, httpService } = buildService({ reasoning: { enabled: true, effort: 'low' } });

    await service.generateComprehensiveSummary('consultation-A', { includeNER: false });

    expect(lastPostBody(httpService).reasoning).toEqual({ enabled: true, effort: 'low' });
  });

  it('an agent with no reasoning opinion sends no `reasoning` key at all', async () => {
    const { service, httpService } = buildService({ temperature: 0.1 });

    await service.generateComprehensiveSummary('consultation-A', { includeNER: false });

    expect(Object.keys(lastPostBody(httpService))).not.toContain('extra');
  });
});
