/**
 * A pre-summary belongs to the encounter it was generated in: the PRE_SUMMARY `generatePreSummary`
 * stores carries the consultation's current encounter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';

const CID = 'c-982';
const TENANT = 'tenant-982';

const VITALS = { bloodPressure: '128/82', heartRate: 88, temperature: 36.8 };
const NOTES = {
  notes: [
    { date: '2026-01-14', title: 'Hypertension review', text: 'PRIOR-NOTE-ALPHA: controlled on amlodipine 5 mg.' },
    { date: '2026-03-02', title: 'Lipid panel follow-up', text: 'PRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.' },
  ],
};

/** What the open-time materializer writes for each of those notes. */
const MATERIALIZED = NOTES.notes.map((note) => `${note.title}\n${note.text}`);

interface Wiring {
  /** `{ [kindKey]: payload }` the consultation carries as STRUCTURED context items. */
  kinds?: Record<string, unknown>;
  caseNotes?: string[];
}

function buildService(wiring: Wiring = {}) {
  const assemble = vi.fn().mockResolvedValue({
    userPrompt: 'assembled',
    systemPrompt: '',
    hyperparameters: {},
    responseFormat: null,
    resolvedFrom: 'tenant',
  });

  const contextItemRepository = {
    findCaseNotes: vi.fn(async () => (wiring.caseNotes ?? MATERIALIZED).map((content, index) => ({ id: `cn-${index}`, content }))),
    findTranscripts: vi.fn(async () => [{ id: 'tr-1', content: 'Today: patient reports chest tightness.' }]),
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) => {
      const payload = wiring.kinds?.[kindKey];
      return payload === undefined ? null : { id: `ci-${kindKey}`, kindKey, content: JSON.stringify(payload), createdAt: new Date() };
    }),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: unknown) => ({ ...(entity as object), id: 'ctx-new', createdAt: new Date(), updatedAt: new Date() })),
    encryptContentIntoEntity: vi.fn(),
  };

  const consultationRepository = {
    findById: vi.fn(async () => ({
      id: CID,
      tenantId: TENANT,
      doctorId: 'doctor-1',
      departmentId: 'dept-1',
      parentConsultationId: null,
      metadata: null,
      currentEncounterSeq: 2,
    })),
  };

  const service = new SummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn() } as never, // summaryMetaRepository
    { create: vi.fn() } as never, // namedEntityRepository
    { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'generated', modelName: 'm' } }) } } as never,
    { get: vi.fn((k: string) => (k === 'TEXT_URL' ? 'http://text' : k === 'NLP_URL' ? 'http://nlp' : undefined)) } as never,
    { emit: vi.fn() } as never,
    { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : null)), set: vi.fn() } as never,
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn() } as never, // contextItemVersionRepository
    { assemble } as never,
    undefined, // secretsService
    undefined, // userProfileRepository
    undefined, // harnessAuditService
    undefined, // harnessGatewayService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) } as never,
  );

  return { service, assemble, contextItemRepository };
}

beforeEach(() => vi.clearAllMocks());

describe('generatePreSummary — the encounter the pre-summary was written in', () => {
  it('stamps the PRE_SUMMARY with the consultation’s current encounter', async () => {
    const { service, contextItemRepository } = buildService();

    await service.generatePreSummary(CID, {} as never);

    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [{ type: string; encounterSeq?: number | null }];
    expect(created.type).toBe('PRE_SUMMARY');
    expect(created.encounterSeq).toBe(2);
  });
});
