/**
 * Live NER transcript re-point + source-grounding (SPEER).
 *
 * The live loop generated a running SOAP note from TEXT and then ran NER OVER THAT
 * GENERATED NOTE, publishing the entities to the clinician's live panel. Because the
 * LLM note carries a material hallucination base rate, an invented finding/medication
 * became a highlighted, first-class clinical entity — the loop LAUNDERED summary
 * hallucinations into entities. This suite pins the corrected contract:
 *
 *   - NER runs over the RAW TRANSCRIPT DELTA (the same text that feeds TEXT),
 *           not `runningSummary`.  [RED on the old code — it passed the note]
 *   - A token present only in the generated note (no transcript support) is
 *           NEVER surfaced as an entity.  [RED on the old code — NER saw the note]
 *   - Published entity offsets index the rendered note (`runningSummary`) — a
 *           re-point must GROUND (re-locate) each transcript entity into the note so no
 *           offset points into a different string than the one the panel renders.
 *   - Live entities stay EPHEMERAL — only `runningSummary` is persisted (as the
 *           PRE_SUMMARY snapshot); no NamedEntity / entity row is ever written.
 *   - The running highlight set is preserved across flushes (recall) even though
 *           NER only ever sees the new delta.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-477';
const TENANT = 'tenant-abc';

// A small deterministic NER vocabulary. The mock returns an entity for each vocab term
// it finds in the text it is GIVEN (case-insensitive) — modelling a real NER, which only
// recognizes spans present in its input. So feeding it the note vs the transcript changes
// what comes back: that difference is exactly what the transcript-vs-note
// re-pointing guarantee turns on.
const NER_VOCAB = ['amlodipine', 'metformin', 'aspirin', 'cough', 'fever', 'hypertension'] as const;
const TYPE_OF: Record<string, string> = {
  amlodipine: 'MEDICATION',
  metformin: 'MEDICATION',
  aspirin: 'MEDICATION',
  cough: 'SYMPTOM',
  fever: 'SYMPTOM',
  hypertension: 'CONDITION',
};

/**
 * Fail-CLOSED `nlp.ner` selection (`resolveNerModelInjection`) means any fixture
 * reaching the NER hop must wire BOTH a resolvable AiRoutingPolicy row and a CLS
 * scope to pin the SYSTEM-only read to — an absent either is a 503, not a
 * silent post without `model_name`.
 */
const nerRoutingElectionDouble = () => ({
  resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }),
});
const nerClsDouble = () => ({ run: vi.fn((callback: () => unknown) => callback()), set: vi.fn(), get: vi.fn() });

function nerEntitiesFor(text: string) {
  const lower = text.toLowerCase();
  const ents: Array<{ entity_type: string; text: string; confidence: number; position: { start: number; end: number } }> = [];
  for (const term of NER_VOCAB) {
    const at = lower.indexOf(term);
    if (at >= 0) {
      ents.push({
        entity_type: TYPE_OF[term],
        text: text.slice(at, at + term.length),
        confidence: 0.9,
        position: { start: at, end: at + term.length },
      });
    }
  }
  return ents;
}

interface HttpMockOpts {
  /** Fixed TEXT `/generate` note. */
  note?: string;
  /** When set, the note is derived from the TEXT prompt (cumulative) — for the recall test. */
  noteFromPrompt?: boolean;
}

/** A note that grows to name whichever recall terms have entered the TEXT prompt so far. */
function noteFromPrompt(prompt: string): string {
  const present = ['cough', 'fever'].filter((t) => prompt.toLowerCase().includes(t));
  return `Subjective: patient reports ${present.join(' and ')}.`;
}

function buildHttpMock(opts: HttpMockOpts = {}) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: { text?: string; prompt?: string }) => {
        if (url.includes('/classify/tokens')) {
          return Promise.resolve({ data: { entities: nerEntitiesFor(body?.text ?? '') } });
        }
        if (url.includes('/generate')) {
          const note = opts.noteFromPrompt ? noteFromPrompt(body?.prompt ?? '') : (opts.note ?? '');
          return Promise.resolve({ data: { summary: note } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

function buildDeps(httpMock = buildHttpMock()) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const audioBridge = {
    subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }),
    unsubscribeFromResults: vi.fn(),
  };
  const contextItemRepository = {
    create: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    update: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    // `findLiveSnapshotRow` now delegates to this repository helper;
    // mirror it through the SAME `findPreSummaries` mock above.
    findLatestPreSummaryWithDecryptedContent: vi.fn(async (consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
      const rows: Array<{ metaData?: unknown; createdAt: Date; content?: string | null }> =
        await contextItemRepository.findPreSummaries(consultationId);
      const candidates = options?.subType
        ? rows.filter((r) => (r.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
        : rows;
      if (candidates.length === 0) return { entity: null, plaintext: null };
      const entity = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      return { entity, plaintext: entity.content ?? null };
    }),
  };
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const harnessPolicyService = {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'live-medgemma' }),
  };

  const service = new LiveDocumentationService(
    httpMock as any,
    configService as any,
    cacheService as any,
    redisSubscriber as any,
    audioBridge as any,
    contextItemRepository as any,
    harnessPolicyService as any,
    undefined, // secretsService
    undefined, // trajectoryService
    undefined, // effectiveSettings
    nerRoutingElectionDouble() as any,
    nerClsDouble() as any,
  );

  return { service, cacheService, contextItemRepository, httpMock };
}

describe('LiveDocumentationService — live NER re-point + source-grounding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // RED on the old code: NER was handed `runningSummary` (the generated note).
  it('runs NER over the raw transcript delta, not the generated note', async () => {
    // The note names a medication ('metformin') that the transcript never does.
    const httpMock = buildHttpMock({ note: 'Assessment: cough. Plan: prescribed metformin.' });
    const { service } = buildDeps(httpMock);
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    const nlpCall = httpMock.axiosRef.post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'))!;
    // The NER call receives the transcript delta (the text that fed TEXT) — NOT the note.
    expect(nlpCall[1].text).toBe('patient reports a cough');
    expect(nlpCall[1].text).not.toBe(payload!.runningSummary);
  });

  // RED on the old code: NER ran over the note, so 'metformin' (a note-only
  // hallucination absent from the transcript) was surfaced as a first-class entity.
  it('does not launder a note-only hallucination into a clinical entity', async () => {
    const httpMock = buildHttpMock({ note: 'Subjective: cough. Plan: prescribed metformin 500mg.' });
    const { service } = buildDeps(httpMock);
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    const texts = payload!.entities.map((e) => e.text.toLowerCase());
    // The transcript-supported entity IS surfaced …
    expect(texts).toContain('cough');
    // … but the note-only hallucination is NOT (NER never sees the note).
    expect(texts).not.toContain('metformin');
  });

  // Grounding guard: after re-pointing to the transcript, offsets must be
  // re-located into the rendered note, or they would index the transcript string.
  it('entity highlight offsets index the rendered note (runningSummary)', async () => {
    // 'cough' sits at offset 0 in the transcript but much later in the note — a stale
    // transcript offset would slice the wrong characters out of `runningSummary`.
    const httpMock = buildHttpMock({ note: 'Subjective: the patient has a cough today.' });
    const { service } = buildDeps(httpMock);
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'cough reported early', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.entities.length).toBeGreaterThan(0);
    for (const e of payload!.entities) {
      expect(payload!.runningSummary.slice(e.start!, e.end!).toLowerCase()).toBe(e.text.toLowerCase());
    }
  });

  // Ephemeral posture: entities ride the SSE payload only; the sole durable write
  // is the PRE_SUMMARY snapshot whose content is `runningSummary` — never an entity row.
  it('keeps live entities ephemeral — persists only runningSummary, never entity rows', async () => {
    const httpMock = buildHttpMock({ note: 'Subjective: cough. Plan: aspirin daily.' });
    const { service, contextItemRepository } = buildDeps(httpMock);
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doc-1' });
    service.ingestSegment(CID, { text: 'cough, takes aspirin', isFinal: true, segmentId: 's1' });

    const final = await service.stop(CID, { persistSnapshot: true });

    // Entities were published (ephemeral clinician UX) …
    expect(final!.entities.map((e) => e.text.toLowerCase())).toEqual(expect.arrayContaining(['cough', 'aspirin']));
    // … but the ONLY durable write is the snapshot, and its content is the note text.
    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
    const persisted = contextItemRepository.create.mock.calls[0][0];
    expect(persisted.content).toBe(final!.runningSummary);
    // No entity class/rows leak into the durable row.
    expect(JSON.stringify(persisted)).not.toContain('MEDICATION');
    expect(JSON.stringify(persisted)).not.toContain('SYMPTOM');
  });

  // Recall guard: NER sees only the delta each flush, so the running set must be
  // merged across flushes; an entity extracted earlier and still present in the cumulative
  // note must not fall out.
  it('preserves the running entity set across flushes (recall)', async () => {
    const httpMock = buildHttpMock({ noteFromPrompt: true });
    const { service } = buildDeps(httpMock);
    service.start({ consultationId: CID, tenantId: TENANT });

    service.ingestSegment(CID, { text: 'patient has a cough', isFinal: true, segmentId: 's1' });
    const p1 = await service.flush(CID, { force: true });
    expect(p1!.entities.map((e) => e.text.toLowerCase())).toContain('cough');

    service.ingestSegment(CID, { text: 'and now a fever', isFinal: true, segmentId: 's2' });
    const p2 = await service.flush(CID, { force: true });

    const texts2 = p2!.entities.map((e) => e.text.toLowerCase());
    expect(texts2).toContain('fever'); // the new delta's entity …
    expect(texts2).toContain('cough'); // … and the earlier one, still in the cumulative note.
  });
});
