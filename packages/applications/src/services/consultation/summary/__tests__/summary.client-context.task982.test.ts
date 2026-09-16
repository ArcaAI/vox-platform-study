/**
 * `generatePreSummary` and `generateSummary` hand the CLIENT's context to the prompt.
 *
 * Both methods already hold the consultation, and the two kinds the client stated at `open` are
 * rows on it — but neither read them, so every prompt they assembled claimed `Not available` for
 * vitals and an empty prior-visit history for a consultation whose clinic had sent both.
 *
 * The pre-summary path carried a second defect of its own: it passed the case-note records as
 * `transcript`. A `transcript` section tells the model "this is what was said in today's
 * encounter"; these are records of previous ones. And when the client ALSO sent those same notes
 * as `previous_case_notes`, the prompt carried each note twice — once as prior-visit context and
 * once as a case-note record — which is how a model ends up documenting one history as two.
 *
 * Every assertion below is on what reaches `PromptAssemblyService.assemble`, because that is the
 * seam both native pre-summary entry points and the summary path converge on.
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

const paramsOf = (assemble: ReturnType<typeof vi.fn>) => assemble.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('generatePreSummary hands the client context to assembly', () => {
  it('passes the rendered vitals and prior-visit history', async () => {
    const { service, assemble } = buildService({ kinds: { vitals: VITALS, previous_case_notes: NOTES } });

    await service.generatePreSummary(CID, {} as never);

    const params = paramsOf(assemble);
    expect(params.vitals).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C');
    expect(params.previousVisits).toContain('PRIOR-NOTE-BRAVO');
    expect(params.previousVisits).toContain('PRIOR-NOTE-ALPHA');
  });

  it('passes the case-note records as `caseNotes`, never as the transcript', async () => {
    const { service, assemble } = buildService({ caseNotes: ['A clinician note written during this visit.'] });

    await service.generatePreSummary(CID, {} as never);

    const params = paramsOf(assemble);
    expect(params.caseNotes).toEqual(['A clinician note written during this visit.']);
    expect(params.transcript).toBe('');
  });

  it('drops the case-note copies of notes already carried as prior-visit context — no note twice', async () => {
    const { service, assemble } = buildService({
      kinds: { previous_case_notes: NOTES },
      caseNotes: [...MATERIALIZED, 'A note the clinician wrote today.'],
    });

    await service.generatePreSummary(CID, {} as never);

    const params = paramsOf(assemble);
    expect(params.caseNotes).toEqual(['A note the clinician wrote today.']);
    expect(params.previousVisits).toContain('PRIOR-NOTE-ALPHA');
  });

  it('keeps every case note when the client sent no prior-visit kind', async () => {
    const { service, assemble } = buildService({ caseNotes: MATERIALIZED });

    await service.generatePreSummary(CID, {} as never);

    expect(paramsOf(assemble).caseNotes).toEqual(MATERIALIZED);
  });

  it('still refuses a consultation with no case notes at all', async () => {
    const { service } = buildService({ caseNotes: [] });

    await expect(service.generatePreSummary(CID, {} as never)).rejects.toThrow(/No case notes/);
  });

  it('generates even when the client sent neither kind — both are simply absent', async () => {
    const { service, assemble } = buildService();

    await service.generatePreSummary(CID, {} as never);

    const params = paramsOf(assemble);
    expect(params.vitals).toBeUndefined();
    expect(params.previousVisits).toBeUndefined();
  });
});

describe('generateSummary hands the client context to assembly', () => {
  it('passes the rendered vitals and prior-visit history beside the transcript', async () => {
    const { service, assemble } = buildService({ kinds: { vitals: VITALS, previous_case_notes: NOTES } });

    await service.generateSummary(CID, {} as never);

    const params = paramsOf(assemble);
    expect(params.vitals).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C');
    expect(params.previousVisits).toContain('PRIOR-NOTE-ALPHA');
    // The authoritative summary still documents from today's transcript.
    expect(params.transcript).toContain('chest tightness');
  });
});
