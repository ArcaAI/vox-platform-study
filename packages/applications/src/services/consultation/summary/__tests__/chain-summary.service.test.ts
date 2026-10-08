/**
 * ChainSummaryService Unit Tests
 *
 * Tests for the comprehensive cross-chain summary generation service.
 * Verifies:
 *   - Linked consultation resolution (chain + same-day strategies)
 *   - Section gathering across multiple consultations
 *   - NER entity aggregation
 *   - Agent-plane invocation (TASK-1006 — the tenant's TEXT_GENERATION agent, not a direct TEXT call)
 *   - Context item persistence
 *   - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ChainSummaryService } from '../chain-summary.service';
import { SysEventType } from '@arcaai/domains';

// Mock ContextItemFactory
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
    SummaryMetaFactory: {
      CreateSummaryMeta: vi.fn((props) => ({
        id: 'meta-1',
        ...props,
      })),
    },
  };
});

// ============================================
// Mock Factories
// ============================================

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'doctor-A', firstName: 'Dr', lastName: 'A' };
    return null;
  }),
  set: vi.fn(),
});

const createMockEventEmitter = () => ({
  emit: vi.fn(),
});

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findTranscripts: vi.fn().mockResolvedValue([]),
  findSummaries: vi.fn().mockResolvedValue([]),
  findCaseNotes: vi.fn().mockResolvedValue([]),
  findPreSummaries: vi.fn().mockResolvedValue([]),
  findSharedContext: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockImplementation((item) => Promise.resolve(item)),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn(),
  findConsultationChain: vi.fn().mockResolvedValue([]),
  findByPatientAndDate: vi.fn().mockResolvedValue([]),
});

const createMockSummaryMetaRepository = () => ({
  create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
});

const createMockNamedEntityRepository = () => ({
  findByContextItem: vi.fn().mockResolvedValue([]),
});

const AGENT = { slug: 'general-medicine-summarization', task: 'TEXT_GENERATION', agentVersionId: 'agent-v-1' };

const createMockAgentResolver = () => ({
  resolve: vi.fn().mockResolvedValue(AGENT),
});

/** The shape `AgentInvocationService.invokeText` answers with in blocking mode. */
const agentResult = (text: string, overrides: Record<string, unknown> = {}) => ({
  text,
  provider: null,
  model: null,
  usage: null,
  usageDetail: null,
  promptFragments: null,
  ...overrides,
});

const createMockAgentInvocation = () => ({
  invokeText: vi.fn().mockResolvedValue(agentResult('Result.')),
});

type InvokeInput = { text: string; variables: Record<string, string> };

// ============================================
// Test Helpers
// ============================================

const createConsultation = (overrides: Record<string, unknown> = {}) => ({
  id: 'consultation-A',
  tenantId: 'tenant-1',
  patientId: 'patient-1',
  doctorId: 'doctor-A',
  departmentId: 'dept-general',
  appointmentDate: new Date('2026-02-17'),
  parentConsultationId: null,
  metadata: null,
  Doctor: { username: 'Dr. A' },
  Department: { name: 'General Medicine' },
  ...overrides,
});

const createContextItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctx-1',
  consultationId: 'consultation-A',
  type: 'TRANSCRIPT',
  content: 'Patient presents with headache.',
  createdAt: new Date('2026-02-17T09:00:00Z'),
  ...overrides,
});

const createNamedEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'ne-1',
  contextItemId: 'ctx-1',
  text: 'Aspirin 75mg',
  className: 'MEDICATION',
  confidence: 0.95,
  ...overrides,
});

// ============================================
// Instantiate service with mocks
// ============================================

function createService(options: { secretsService?: unknown; noteGenerationService?: unknown } = {}) {
  const contextItemRepo = createMockContextItemRepository();
  const consultationRepo = createMockConsultationRepository();
  const summaryMetaRepo = createMockSummaryMetaRepository();
  const namedEntityRepo = createMockNamedEntityRepository();
  const eventEmitter = createMockEventEmitter();
  const clsService = createMockClsService();
  const agentResolver = createMockAgentResolver();
  const agentInvocation = createMockAgentInvocation();

  const service = new ChainSummaryService(
    contextItemRepo as any,
    consultationRepo as any,
    summaryMetaRepo as any,
    namedEntityRepo as any,
    eventEmitter as any,
    clsService as any,
    agentResolver as any,
    agentInvocation as any,
    options.secretsService as any, // secretsService (@Optional)
    undefined, // usageLedger
    undefined, // unitOfWork
    options.noteGenerationService as any, // noteGenerationService
  );

  return {
    service,
    contextItemRepo,
    consultationRepo,
    summaryMetaRepo,
    namedEntityRepo,
    eventEmitter,
    clsService,
    agentResolver,
    agentInvocation,
  };
}

/** The `input` of the (first) agent invocation. */
const invokedInput = (mocks: ReturnType<typeof createService>): InvokeInput => mocks.agentInvocation.invokeText.mock.calls[0][2] as InvokeInput;

// ============================================
// Tests
// ============================================

describe('ChainSummaryService', () => {
  let mocks: ReturnType<typeof createService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createService();
  });

  describe('resolveLinkedConsultations', () => {
    it('should combine chain-based and date-based strategies', async () => {
      const consultationA = createConsultation({ id: 'A' });
      const consultationB = createConsultation({ id: 'B', parentConsultationId: 'A', departmentId: 'dept-hematology' });
      const consultationC = createConsultation({ id: 'C', doctorId: 'doctor-C', departmentId: 'dept-lab' });

      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultationA, consultationB]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultationA, consultationC]);

      const result = await mocks.service.resolveLinkedConsultations(consultationA as any);

      expect(result).toHaveLength(3);
      expect(result.map((c) => c.id)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    });

    it('should deduplicate when chain and date overlap', async () => {
      const consultationA = createConsultation({ id: 'A' });
      const consultationB = createConsultation({ id: 'B', parentConsultationId: 'A' });

      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultationA, consultationB]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultationA, consultationB]);

      const result = await mocks.service.resolveLinkedConsultations(consultationA as any);

      expect(result).toHaveLength(2);
    });

    it('should return chain-only when no same-day consultations exist', async () => {
      const consultationA = createConsultation({ id: 'A' });

      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultationA]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultationA]);

      const result = await mocks.service.resolveLinkedConsultations(consultationA as any);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('A');
    });
  });

  describe('gatherSections', () => {
    it('should prefer summaries over raw transcripts', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([
        createContextItem({ id: 'summary-1', type: 'RAW_SUMMARY', content: 'Summary of consultation.' }),
      ]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ id: 'transcript-1', content: 'Raw transcript text.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(1);
      expect(sections[0].type).toBe('summary');
      expect(sections[0].content).toBe('Summary of consultation.');
    });

    it('should fall back to transcripts when no summary exists', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ id: 'transcript-1', content: 'Raw transcript text.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(1);
      expect(sections[0].type).toBe('transcript');
    });

    it('should include case notes alongside summaries', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ type: 'RAW_SUMMARY', content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([createContextItem({ type: 'CASE_NOTE', content: 'Historical case note.' })]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(2);
      expect(sections.map((s) => s.type)).toEqual(['summary', 'case_note']);
    });

    it('should gather from multiple consultations', async () => {
      const consultationA = createConsultation({ id: 'A' }) as any;
      const consultationB = createConsultation({
        id: 'B',
        departmentId: 'dept-hematology',
        Doctor: { username: 'Dr. B' },
        Department: { name: 'Hematology' },
      }) as any;

      // Consultation A: has summary
      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ consultationId: 'A', type: 'RAW_SUMMARY', content: 'Summary A.' })])
        .mockResolvedValueOnce([createContextItem({ consultationId: 'B', type: 'RAW_SUMMARY', content: 'Summary B.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultationA, consultationB]);

      expect(sections).toHaveLength(2);
      expect(sections[0].department).toBe('General Medicine');
      expect(sections[1].department).toBe('Hematology');
    });

    it('should skip empty content items', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: '' }), createContextItem({ content: '   ' })]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(0);
    });

    it('should include pre-summaries', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([createContextItem({ type: 'PRE_SUMMARY', content: 'Pre-summary of case notes.' })]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(1);
      expect(sections[0].type).toBe('pre_summary');
    });
  });

  describe('gatherSections — edge cases', () => {
    it('should use departmentId when Department relation is null', async () => {
      const consultation = createConsultation({
        Department: null,
        departmentId: 'dept-xyz',
        Doctor: null,
        doctorId: 'doc-123',
      }) as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ content: 'Transcript.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(1);
      expect(sections[0].department).toBe('dept-xyz');
      expect(sections[0].doctor).toBe('doc-123');
    });

    it('should handle null content in context items', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ content: null })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([createContextItem({ content: null })]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(0);
    });

    it('should include multiple transcripts when no summary exists', async () => {
      const consultation = createConsultation() as any;

      // All three share `createContextItem`'s default `createdAt` — exactly
      // the shape of adjacent same-speaker STT utterances a live session
      // posts. TASK-998 assembles a run like this into ONE paragraph/section
      // instead of one "--- Section N ---" per utterance; no content is lost,
      // it is joined (see transcript-assembly.util.ts).
      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([
        createContextItem({ id: 't1', content: 'Transcript 1.' }),
        createContextItem({ id: 't2', content: 'Transcript 2.' }),
        createContextItem({ id: 't3', content: 'Transcript 3.' }),
      ]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(1);
      expect(sections[0].type).toBe('transcript');
      expect(sections[0].content).toBe('Transcript 1. Transcript 2. Transcript 3.');
    });

    it('should keep transcripts from a real conversational gap as separate sections', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([
        createContextItem({ id: 't1', content: 'Opening remarks.', createdAt: new Date('2026-02-17T09:00:00Z') }),
        // 5 minutes later — well past the default assembly gap threshold.
        createContextItem({ id: 't2', content: 'Follow-up after a long pause.', createdAt: new Date('2026-02-17T09:05:00Z') }),
      ]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      expect(sections).toHaveLength(2);
      expect(sections[0].content).toBe('Opening remarks.');
      expect(sections[1].content).toBe('Follow-up after a long pause.');
    });

    it('should only use latest summary even when multiple exist', async () => {
      const consultation = createConsultation() as any;

      mocks.contextItemRepo.findSummaries.mockResolvedValue([
        createContextItem({ id: 's1', content: 'Old summary.' }),
        createContextItem({ id: 's2', content: 'Latest summary.' }),
      ]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const sections = await mocks.service.gatherSections([consultation]);

      // Should use the LAST one (latest)
      expect(sections).toHaveLength(1);
      expect(sections[0].content).toBe('Latest summary.');
      expect(sections[0].type).toBe('summary');
    });

    it('should return empty array for empty consultation list', async () => {
      const sections = await mocks.service.gatherSections([]);

      expect(sections).toHaveLength(0);
    });
  });

  describe('gatherNamedEntities', () => {
    it('should aggregate entities by class from all consultations', async () => {
      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ id: 'sum-A' })])
        .mockResolvedValueOnce([createContextItem({ id: 'sum-B' })]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      mocks.namedEntityRepo.findByContextItem
        .mockResolvedValueOnce([
          createNamedEntity({ text: 'Aspirin 75mg', className: 'MEDICATION' }),
          createNamedEntity({ text: 'Hypertension', className: 'CONDITION' }),
        ])
        .mockResolvedValueOnce([createNamedEntity({ text: 'Metformin 500mg', className: 'MEDICATION' })]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A', 'consultation-B']);

      expect(result['MEDICATION']).toHaveLength(2);
      expect(result['CONDITION']).toHaveLength(1);
      expect(result['MEDICATION'].map((e) => e.text)).toEqual(expect.arrayContaining(['Aspirin 75mg', 'Metformin 500mg']));
    });

    it('should deduplicate entities from the same consultation', async () => {
      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ id: 'sum-1' })]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ id: 'trans-1' })]);

      mocks.namedEntityRepo.findByContextItem
        .mockResolvedValueOnce([createNamedEntity({ text: 'Aspirin', className: 'MEDICATION' })])
        .mockResolvedValueOnce([createNamedEntity({ text: 'Aspirin', className: 'MEDICATION' })]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A']);

      expect(result['MEDICATION']).toHaveLength(1);
    });

    it('should return empty map when no entities exist', async () => {
      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A']);

      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should allow same text from different consultations (not dedup cross-consultation)', async () => {
      // Consultation A has "Aspirin", Consultation B also has "Aspirin"
      // They should NOT be deduplicated because they come from different consultations
      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ id: 'sum-A' })]) // A
        .mockResolvedValueOnce([createContextItem({ id: 'sum-B' })]); // B
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      mocks.namedEntityRepo.findByContextItem
        .mockResolvedValueOnce([createNamedEntity({ text: 'Aspirin', className: 'MEDICATION' })]) // from A
        .mockResolvedValueOnce([createNamedEntity({ text: 'Aspirin', className: 'MEDICATION' })]); // from B

      const result = await mocks.service.gatherNamedEntities(['consultation-A', 'consultation-B']);

      // Both should be present — different sourceConsultationId
      expect(result['MEDICATION']).toHaveLength(2);
      expect(result['MEDICATION'][0].sourceConsultationId).toBe('consultation-A');
      expect(result['MEDICATION'][1].sourceConsultationId).toBe('consultation-B');
    });

    it('should handle null className by defaulting to UNKNOWN', async () => {
      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ id: 'sum-1' })]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([createNamedEntity({ text: 'Something', className: null })]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A']);

      expect(result['UNKNOWN']).toHaveLength(1);
      expect(result['UNKNOWN'][0].text).toBe('Something');
    });

    it('should handle null entity text by storing empty string', async () => {
      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ id: 'sum-1' })]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([createNamedEntity({ text: null, className: 'MEDICATION' })]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A']);

      expect(result['MEDICATION']).toHaveLength(1);
      expect(result['MEDICATION'][0].text).toBe('');
    });

    it('should gather entities from transcripts too, not just summaries', async () => {
      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([createContextItem({ id: 'trans-1' })]);

      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([createNamedEntity({ text: 'Ibuprofen', className: 'MEDICATION' })]);

      const result = await mocks.service.gatherNamedEntities(['consultation-A']);

      expect(result['MEDICATION']).toHaveLength(1);
      expect(result['MEDICATION'][0].text).toBe('Ibuprofen');
    });

    it('should return empty map for empty consultation ID list', async () => {
      const result = await mocks.service.gatherNamedEntities([]);

      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe('agent input composition', () => {
    it('should include section headers with department, doctor, type in the text sent to the agent', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Important findings here.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      await mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false });

      const prompt = invokedInput(mocks).text;

      expect(prompt).toContain('--- Section 1 ---');
      expect(prompt).toContain('Department: General Medicine');
      expect(prompt).toContain('Doctor: Dr. A');
      expect(prompt).toContain('Type: summary');
      expect(prompt).toContain('Important findings here.');
    });

    it('should append NER context to the text when entities exist', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ content: 'Summary.' })]) // gatherSections
        .mockResolvedValueOnce([createContextItem({ id: 'sum-1' })]); // gatherNamedEntities
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);

      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([
        createNamedEntity({ text: 'Aspirin 75mg', className: 'MEDICATION' }),
        createNamedEntity({ text: 'Hypertension', className: 'CONDITION' }),
      ]);

      await mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: true });

      const prompt = invokedInput(mocks).text;

      expect(prompt).toContain('--- Named Entities (auto-extracted) ---');
      expect(prompt).toContain('MEDICATION: Aspirin 75mg');
      expect(prompt).toContain('CONDITION: Hypertension');
    });

    it('carries only `text` and `variables` — a request`s template / options select nothing on the agent plane', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      await mocks.service.generateComprehensiveSummary('consultation-A', {
        includeNER: false,
        template: 'SOAP',
        options: { textProvider: 'openai', textModel: 'caller-pinned' },
      });

      // The agent owns its instruction and its model; the caller no longer overrides either.
      expect(Object.keys(invokedInput(mocks)).sort()).toEqual(['text', 'variables']);
      expect(JSON.stringify(invokedInput(mocks))).not.toContain('caller-pinned');
    });
  });

  describe('generateComprehensiveSummary', () => {
    it('should generate a comprehensive summary across linked consultations', async () => {
      const consultationA = createConsultation({ id: 'A' });
      const consultationB = createConsultation({
        id: 'B',
        parentConsultationId: 'A',
        departmentId: 'dept-hematology',
        Doctor: { username: 'Dr. B' },
        Department: { name: 'Hematology' },
      });

      mocks.consultationRepo.findById.mockResolvedValue(consultationA);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultationA, consultationB]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultationA, consultationB]);

      // Consultation A: has summary
      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ consultationId: 'A', content: 'Summary A.' })])
        .mockResolvedValueOnce([createContextItem({ consultationId: 'B', content: 'Summary B.' })])
        .mockResolvedValueOnce([createContextItem({ id: 'sum-A' })]) // for NER gathering
        .mockResolvedValueOnce([createContextItem({ id: 'sum-B' })]); // for NER gathering
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]); // for NER gathering
      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockResolvedValue(
        agentResult('Comprehensive summary spanning General Medicine and Hematology.', {
          model: 'gpt-4o',
          usage: { promptTokens: 1500, completionTokens: 500 },
        }),
      );

      const result = await mocks.service.generateComprehensiveSummary('A', {
        includeNER: true,
      });

      expect(result.id).toBe('ctx-comprehensive-1');
      expect(result.content).toBe('Comprehensive summary spanning General Medicine and Hematology.');
      expect(result.sourceConsultationIds).toEqual(expect.arrayContaining(['A', 'B']));
      expect(result.sectionCount).toBe(2);
      expect(result.structuredData?.modelName).toBe('gpt-4o');

      // Verify the tenant's agent was resolved and invoked (TASK-1006 — never a direct TEXT call)
      expect(mocks.agentResolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', task: 'TEXT_GENERATION', departmentId: 'dept-general' }),
      );
      expect(mocks.agentInvocation.invokeText).toHaveBeenCalledWith(
        AGENT,
        'tenant-1',
        expect.objectContaining({
          text: expect.stringContaining('--- Section 1 ---'),
          variables: expect.objectContaining({ current_department: 'General Medicine' }),
        }),
        'blocking',
        // TASK-1050 — the guardrail attribution (consultation + composed items).
        expect.objectContaining({ attribution: expect.objectContaining({ regionItems: expect.any(Object) }) }),
      );

      // Verify context item was persisted
      expect(mocks.contextItemRepo.create).toHaveBeenCalled();
      expect(mocks.summaryMetaRepo.create).toHaveBeenCalled();

      // Verify SysEvent was broadcast
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'comprehensive_summary',
            sourceConsultationIds: expect.arrayContaining(['A', 'B']),
          }),
        }),
      );
    });

    it('should throw NotFoundException when consultation not found', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(null);

      await expect(mocks.service.generateComprehensiveSummary('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when tenant ID is missing', async () => {
      mocks.clsService.get.mockImplementation(() => null);
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());

      await expect(mocks.service.generateComprehensiveSummary('A', {})).rejects.toThrow(BadRequestException);
      expect(mocks.agentInvocation.invokeText).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when no content available', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      // All empty
      mocks.contextItemRepo.findSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      await expect(mocks.service.generateComprehensiveSummary('consultation-A', {})).rejects.toThrow(BadRequestException);
      expect(mocks.agentInvocation.invokeText).not.toHaveBeenCalled();
    });

    it('should skip NER gathering when includeNER is false', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const result = await mocks.service.generateComprehensiveSummary('consultation-A', {
        includeNER: false,
      });

      expect(result.namedEntities).toBeUndefined();
      expect(mocks.namedEntityRepo.findByContextItem).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when the agent invocation fails in transport', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockRejectedValue(new Error('TEXT timeout'));

      await expect(mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false })).rejects.toThrow(BadRequestException);
      expect(mocks.contextItemRepo.create).not.toHaveBeenCalled();
    });

    it('should default includeNER to true when not specified', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries
        .mockResolvedValueOnce([createContextItem({ content: 'Summary.' })]) // gatherSections
        .mockResolvedValueOnce([createContextItem({ id: 'sum-1' })]); // gatherNamedEntities
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);
      mocks.contextItemRepo.findTranscripts.mockResolvedValue([]);
      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([]);

      // Empty request — includeNER defaults to true (not false)
      const result = await mocks.service.generateComprehensiveSummary('consultation-A', {});

      // namedEntities should be defined (even if empty) because NER was gathered
      expect(result.namedEntities).toBeDefined();
      expect(mocks.namedEntityRepo.findByContextItem).toHaveBeenCalled();
    });

    it('should use the provider as fallback when the model is not reported', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockResolvedValue(agentResult('Result.', { provider: 'anthropic', model: null }));

      const result = await mocks.service.generateComprehensiveSummary('consultation-A', {
        includeNER: false,
      });

      expect(result.structuredData?.modelName).toBe('anthropic');
    });

    it('should pass correct fields to SummaryMetaFactory.CreateSummaryMeta', async () => {
      const { SummaryMetaFactory } = await import('@arcaai/domains');
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockResolvedValue(
        agentResult('Result.', {
          model: 'gpt-4o',
          usage: { promptTokens: 800, completionTokens: 200 },
          // TEXT's own usage block: the wall clock the summary metadata reports.
          usageDetail: { task_id: 't-1', provider: 'openai', model: 'gpt-4o', endpoint_kind: 'lmstudio.chat', total_ms: 3500 },
        }),
      );

      await mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false });

      expect(SummaryMetaFactory.CreateSummaryMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          contextItemId: 'ctx-comprehensive-1',
          aiModelId: 'gpt-4o',
          processingTimeMs: 3500,
          inputTokens: 800,
          outputTokens: 200,
        }),
      );
    });

    it('should pass ContextItemFactory correct arguments', async () => {
      const { ContextItemFactory } = await import('@arcaai/domains');
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockResolvedValue(agentResult('Generated comprehensive.'));

      await mocks.service.generateComprehensiveSummary('consultation-A', {
        dnaStyleId: 'my-style',
        includeNER: false,
      });

      expect(ContextItemFactory.CreateRawSummary).toHaveBeenCalledWith(
        'tenant-1', // tenantId
        'consultation-A', // consultationId
        'Generated comprehensive.', // content from the agent
        'my-style', // dnaStyleId from request
        'doctor-A', // userId from CLS
      );
    });

    it('should return complete response shape with all required fields', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);

      mocks.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Summary.' })]);
      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);

      const result = await mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false });

      // All fields from ComprehensiveSummaryResponse must be present
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('consultationId');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('sourceConsultationIds');
      expect(result).toHaveProperty('sectionCount');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(typeof result.createdAt).toBe('string'); // ISO string, not Date
      expect(typeof result.updatedAt).toBe('string');
    });

    it('should handle realistic multi-department workflow (3 consultations)', async () => {
      const consultationA = createConsultation({ id: 'A', Department: { name: 'General Medicine' } });
      const consultationB = createConsultation({
        id: 'B',
        parentConsultationId: 'A',
        Department: { name: 'Hematology' },
        Doctor: { username: 'Dr. B' },
      });
      const consultationC = createConsultation({ id: 'C', Department: { name: 'Laboratory' }, Doctor: { username: 'Lab Tech' } });

      mocks.consultationRepo.findById.mockResolvedValue(consultationA);
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([consultationA, consultationB]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([consultationA, consultationB, consultationC]);

      // gatherSections iterates A, B, C in order. For each:
      //   findSummaries → findTranscripts (if no summaries) → findCaseNotes → findPreSummaries
      // Then gatherNamedEntities iterates A, B, C and for each:
      //   findSummaries → findTranscripts
      mocks.contextItemRepo.findSummaries
        // gatherSections pass
        .mockResolvedValueOnce([createContextItem({ consultationId: 'A', content: 'Summary A.' })]) // A: has summary
        .mockResolvedValueOnce([createContextItem({ consultationId: 'B', content: 'Summary B.' })]) // B: has summary
        .mockResolvedValueOnce([]) // C: no summary — will fall back to transcripts
        // gatherNamedEntities pass
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      // findTranscripts: only called for C during gatherSections (A and B have summaries)
      mocks.contextItemRepo.findTranscripts
        .mockResolvedValueOnce([createContextItem({ consultationId: 'C', content: 'Lab results: CBC normal.' })]) // C fallback
        // gatherNamedEntities pass
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mocks.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      mocks.contextItemRepo.findPreSummaries.mockResolvedValue([]);
      mocks.namedEntityRepo.findByContextItem.mockResolvedValue([]);

      mocks.agentInvocation.invokeText.mockResolvedValue(agentResult('Comprehensive multi-department summary.', { model: 'gpt-4o' }));

      const result = await mocks.service.generateComprehensiveSummary('A', { includeNER: true });

      expect(result.sourceConsultationIds).toHaveLength(3);
      expect(result.sectionCount).toBe(3); // Summary A + Summary B + Transcript C
    });
  });

  // ============================================================
  // Cross-aggregate tenant isolation for ChainSummaryService
  //
  // The comprehensive-summary endpoint loads the requesting consultation
  // by id AND traverses the full chain via `findConsultationChain`
  // (which is NOT tenant-scoped at the repository layer). Without these
  // guards a Tenant A doctor could submit a Tenant B consultation id and
  // receive a multi-tenant comprehensive summary containing other-tenant
  // PHI, OR submit a Tenant A id whose chain has been historically
  // poisoned with a cross-tenant parent / child link.
  // ============================================================
  describe('cross-aggregate tenant checks', () => {
    it('throws NotFoundException when the requesting consultation belongs to another tenant', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation({ id: 'c-other', tenantId: 'tenant-OTHER' }));

      await expect(mocks.service.generateComprehensiveSummary('c-other', {} as any)).rejects.toThrow(NotFoundException);

      expect(mocks.agentInvocation.invokeText).not.toHaveBeenCalled();
      expect(mocks.contextItemRepo.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when any consultation resolved in the chain belongs to another tenant', async () => {
      // Requesting consultation passes the in-tenant check.
      const requesting = createConsultation({ id: 'A' });
      mocks.consultationRepo.findById.mockResolvedValue(requesting);

      // Chain contains an in-tenant child PLUS a cross-tenant relative
      // (e.g. legacy data where parentConsultationId points elsewhere).
      mocks.consultationRepo.findConsultationChain.mockResolvedValue([
        requesting,
        createConsultation({ id: 'B', parentConsultationId: 'A' }),
        createConsultation({
          id: 'C-cross',
          tenantId: 'tenant-OTHER',
          parentConsultationId: 'A',
        }),
      ]);
      mocks.consultationRepo.findByPatientAndDate.mockResolvedValue([requesting]);

      await expect(mocks.service.generateComprehensiveSummary('A', {} as any)).rejects.toThrow(NotFoundException);

      expect(mocks.agentInvocation.invokeText).not.toHaveBeenCalled();
      expect(mocks.contextItemRepo.create).not.toHaveBeenCalled();
    });
  });

  // ── F-031 remainder: the comprehensive-summary ContextItem must be
  // encrypted before persist, or its clinical text silently vanishes at rest
  // (the plaintext `content` column was dropped; only `encryptedContent` persists).
  describe('comprehensive summary content encryption-at-rest (F-031)', () => {
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

    const primeComprehensive = (target: ReturnType<typeof createService>) => {
      const consultation = createConsultation();
      target.consultationRepo.findById.mockResolvedValue(consultation);
      target.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      target.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);
      target.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Findings.' })]);
      target.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      target.contextItemRepo.findPreSummaries.mockResolvedValue([]);
      target.agentInvocation.invokeText.mockResolvedValue(agentResult('Comprehensive result.'));
    };

    it('encrypts the generated comprehensive-summary content before persisting', async () => {
      const withSecrets = createService({ secretsService: secretsStub });
      primeComprehensive(withSecrets);

      await withSecrets.service.generateComprehensiveSummary('consultation-A', { includeNER: false } as any);

      expect(withSecrets.contextItemRepo.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = withSecrets.contextItemRepo.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Comprehensive result.');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = withSecrets.contextItemRepo.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = withSecrets.contextItemRepo.create.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(createOrder);
      expect(withSecrets.contextItemRepo.create.mock.calls[0][0]).toBe(entityArg);
    });

    it('still persists (without ciphertext) when no SecretsService is wired', async () => {
      primeComprehensive(mocks);

      await mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false } as any);

      expect(mocks.contextItemRepo.encryptContentIntoEntity).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Generator Entry-Point Seam. Comprehensive-summary has no
  // harness equivalent; the seam call exists purely to log the decision and
  // never blocks/short-circuits generation.
  // ===========================================================================
  describe(' NoteGenerationService seam', () => {
    const primeComprehensive = (target: ReturnType<typeof createService>) => {
      const consultation = createConsultation();
      target.consultationRepo.findById.mockResolvedValue(consultation);
      target.consultationRepo.findConsultationChain.mockResolvedValue([consultation]);
      target.consultationRepo.findByPatientAndDate.mockResolvedValue([consultation]);
      target.contextItemRepo.findSummaries.mockResolvedValue([createContextItem({ content: 'Findings.' })]);
      target.contextItemRepo.findCaseNotes.mockResolvedValue([]);
      target.contextItemRepo.findPreSummaries.mockResolvedValue([]);
    };

    it('calls the seam with COMPREHENSIVE_SUMMARY and generates unaffected by the decision', async () => {
      const noteGenerationService = { generate: vi.fn().mockResolvedValue({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' }) };
      const target = createService({ noteGenerationService });
      primeComprehensive(target);

      const result = await target.service.generateComprehensiveSummary('consultation-A', { includeNER: false });

      expect(noteGenerationService.generate).toHaveBeenCalledWith(
        'COMPREHENSIVE_SUMMARY',
        expect.objectContaining({ consultationId: 'consultation-A', tenantId: 'tenant-1' }),
      );
      expect(result).toBeDefined();
    });

    it('still generates when the seam call fails (best-effort, non-blocking)', async () => {
      const noteGenerationService = { generate: vi.fn().mockRejectedValue(new Error('seam unavailable')) };
      const target = createService({ noteGenerationService });
      primeComprehensive(target);

      await expect(target.service.generateComprehensiveSummary('consultation-A', { includeNER: false })).resolves.toBeDefined();
    });

    it('generates unaffected when noteGenerationService is not wired (pre-fixtures)', async () => {
      primeComprehensive(mocks);

      await expect(mocks.service.generateComprehensiveSummary('consultation-A', { includeNER: false })).resolves.toBeDefined();
    });
  });
});
