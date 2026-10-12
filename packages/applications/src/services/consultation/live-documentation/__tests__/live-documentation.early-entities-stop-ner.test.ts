/**
 * Entities reach the clinician without waiting for the running note.
 *
 * ## What was measured
 *
 * NER answers in ~4 s, the live note's TEXT generation in ~60 s, and a flush published both
 * together — so a consultation shorter than its first generation never showed a highlight, and
 * `stop()` (which supersedes the in-flight generation and runs no live generation) closed on a
 * `lastPayload` that did not exist yet.
 *
 * ## The rules pinned here
 *
 *  A. As soon as the realtime NER stage answers, an EARLY snapshot is published: the note the
 *     session already shows (`lastPayload` sections / runningSummary, unchanged — or the empty note
 *     when there is none yet) plus the new transcript-anchored entities. It never blanks or
 *     regresses the note, and a stale early snapshot never replaces a newer full flush.
 *  B. At stop, NER runs over the UNFLUSHED transcript tail only (still no live generation) and the
 *     closing snapshot carries those entities. Bounded by a short timeout; on timeout or failure
 *     the consultation closes exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveSummaryEventDto } from '../dto/live-summary.dto';

const CID = 'consultation-early-entities';
const TENANT = 'tenant-early-entities';
const U1 = 'patient reports a cough for three days';
const U2 = 'she started metformin last week';

/** The vocabulary the fake NER recognises, wherever it occurs in the text it is sent. */
const VOCAB: Array<[string, string]> = [
  ['cough', 'SIGN_SYMPTOM'],
  ['metformin', 'MEDICATION'],
];

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-10-12T00:00:00.000Z',
});

type Published = LiveSummaryEventDto & { closed?: boolean; event?: string };

function cacheMock() {
  const published: Published[] = [];
  return {
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_channel: string, raw: string) => {
      try {
        published.push(JSON.parse(raw) as Published);
      } catch {
        /* control messages */
      }
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

interface HttpOptions {
  /** Hold the Nth (0-based) `/generate` call until released. */
  holdGenerate?: number;
  /** Hold the Nth (0-based) `/classify/tokens` call until released — IGNORING abort, as a slow NLP would. */
  holdClassify?: number;
  /** The Nth `/classify/tokens` call never answers (and ignores abort). */
  hangClassify?: number;
  /** The Nth `/classify/tokens` call fails. */
  failClassify?: number;
}

function httpMock(options: HttpOptions = {}) {
  let generateCalls = 0;
  let classifyCalls = 0;
  const classifyTexts: string[] = [];
  const generateGate: { release: () => void; started: Promise<void>; markStarted: () => void } = (() => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    return { release: () => undefined, started, markStarted };
  })();
  const classifyGate: { release: () => void; started: Promise<void>; markStarted: () => void } = (() => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    return { release: () => undefined, started, markStarted };
  })();

  const post = vi.fn(async (url: string, body: { text?: string }, config?: { signal?: AbortSignal }) => {
    if (url.includes('/classify/tokens')) {
      const index = classifyCalls++;
      const text = body?.text ?? '';
      classifyTexts.push(text);
      if (index === options.failClassify) throw new Error('Request failed with status code 502');
      if (index === options.hangClassify) {
        classifyGate.markStarted();
        await new Promise<void>(() => undefined);
      }
      if (index === options.holdClassify) {
        classifyGate.markStarted();
        await new Promise<void>((resolve) => (classifyGate.release = resolve));
      }
      const lower = text.toLowerCase();
      const entities = VOCAB.filter(([word]) => lower.includes(word)).map(([word, type]) => {
        const at = lower.indexOf(word);
        return { text: word, entity_type: type, confidence: 0.9, position: { start: at, end: at + word.length } };
      });
      return { data: { entities } };
    }
    if (url.includes('/generate')) {
      const index = generateCalls++;
      if (index === options.holdGenerate) {
        generateGate.markStarted();
        await new Promise<void>((resolve, reject) => {
          generateGate.release = resolve;
          config?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })));
        });
      }
      const addition = index === 0 ? 'Reports a cough for three days.' : 'Started metformin last week.';
      return { data: { summary: JSON.stringify({ subjective: { addition }, objective: null, assessment: null, plan: null }) } };
    }
    return { data: {} };
  });
  return {
    axiosRef: { post },
    post,
    generateGate,
    classifyGate,
    classifyTexts,
    generateCalls: () => generateCalls,
    classifyCalls: () => classifyCalls,
  };
}

function buildService(http: ReturnType<typeof httpMock>, cache: ReturnType<typeof cacheMock>, graph = true) {
  return new LiveDocumentationService(
    http as never,
    { get: vi.fn((k: string) => (k === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
          ? { value: graph, sourceScope: 'tenant' }
          : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null, departmentId: null, parentConsultationId: null })) } as never,
  );
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/** Whole-document snapshots only — the per-section `section.patch` / `presummary` frames carry an `event`. */
const snapshots = (cache: ReturnType<typeof cacheMock>): Published[] => cache.published.filter((p) => p.event === undefined && 'entities' in p);
const texts = (payload: Published | LiveSummaryEventDto | undefined | null): string[] => (payload?.entities ?? []).map((e) => e.text);

async function open(graph = true, options: HttpOptions = {}) {
  const cache = cacheMock();
  const http = httpMock(options);
  const service = buildService(http, cache, graph);
  service.start({ consultationId: CID, tenantId: TENANT });
  await tick();
  return { cache, http, service };
}

const segment = (text: string, i: number) =>
  ({ text, isFinal: true, segmentId: `s${i}`, startTime: i * 3, endTime: i * 3 + 2.5, utteranceIndex: i }) as never;

describe('A — early entity snapshot after the realtime NER stage', () => {
  it('keeps the prior note unchanged and adds the new transcript-anchored entities before the generation answers', async () => {
    const { cache, http, service } = await open(true, { holdGenerate: 1 });
    service.ingestSegment(CID, segment(U1, 0));
    const first = await service.flush(CID);
    expect(first?.runningSummary, 'the first flush produced no note').toBeTruthy();
    expect(texts(first)).toContain('cough');

    service.ingestSegment(CID, segment(U2, 1));
    const second = service.flush(CID, { force: true });
    await http.generateGate.started;

    // The generation is still held: anything carrying `metformin` now is the early snapshot.
    const early = snapshots(cache).find((p) => texts(p).includes('metformin'));
    expect(early, 'no early entity snapshot was published while the generation was in flight').toBeDefined();
    expect(early!.sections).toEqual(first!.sections);
    expect(early!.runningSummary).toBe(first!.runningSummary);
    expect(texts(early)).toContain('cough');
    const metformin = early!.entities.find((e) => e.text === 'metformin');
    expect(metformin).toMatchObject({ type: 'MEDICATION', transcriptSegmentId: 'utt-1', transcriptStart: U2.indexOf('metformin') });
    expect(early!.closed).toBeUndefined();

    http.generateGate.release();
    const full = await second;
    expect(full?.runningSummary).toContain('metformin');
    // The full flush that followed still carries both, deduplicated.
    expect(texts(full).filter((t) => t === 'metformin')).toHaveLength(1);
    expect(texts(full).filter((t) => t === 'cough')).toHaveLength(1);
    await service.stop(CID, { persistSnapshot: false });
  });

  it('with no note yet, publishes the entities on the empty note the session already shows', async () => {
    const { cache, http, service } = await open(true, { holdGenerate: 0 });
    service.ingestSegment(CID, segment(U1, 0));
    const first = service.flush(CID);
    await http.generateGate.started;

    const early = snapshots(cache).find((p) => texts(p).includes('cough'));
    expect(early, 'no early entity snapshot was published before the first note').toBeDefined();
    expect(early!.runningSummary).toBe('');
    expect(early!.sections).toEqual([]);
    const cough = early!.entities.find((e) => e.text === 'cough');
    expect(cough).toMatchObject({ transcriptSegmentId: 'utt-0', transcriptStart: U1.indexOf('cough') });
    // No note ⇒ no note offsets invented.
    expect(cough!.start).toBeUndefined();

    http.generateGate.release();
    const full = await first;
    expect(full?.runningSummary).toContain('cough');
    await service.stop(CID, { persistSnapshot: false });
  });

  it('a stale early snapshot never replaces a newer full flush', async () => {
    // classify #0 = flush 1, #1 = flush 2 (held past its supersession), #2 = flush 3.
    const { cache, http, service } = await open(true, { holdClassify: 1 });
    service.ingestSegment(CID, segment(U1, 0));
    await service.flush(CID);

    service.ingestSegment(CID, segment(U2, 1));
    const stale = service.flush(CID, { force: true });
    await http.classifyGate.started;

    // A newer flush supersedes the held one and completes in full.
    const newer = await service.flush(CID, { force: true });
    expect(newer?.runningSummary).toContain('metformin');
    const publishedBeforeRelease = snapshots(cache).length;

    http.classifyGate.release();
    await stale;
    await tick();

    const after = snapshots(cache).slice(publishedBeforeRelease);
    expect(after, 'the superseded flush published a snapshot after the newer full flush').toEqual([]);
    expect(snapshots(cache).at(-1)?.updatedAt).toBe(newer?.updatedAt);
    await service.stop(CID, { persistSnapshot: false });
  });
});

describe('B — NER over the unflushed tail at stop', () => {
  for (const graph of [true, false]) {
    const lane = graph ? 'graph' : 'legacy';

    it(`${lane}: runs NER on the tail only and the closing snapshot carries its entities — still no generation`, async () => {
      const { cache, http, service } = await open(graph);
      service.ingestSegment(CID, segment(U1, 0));
      const first = await service.flush(CID);
      const generateBeforeStop = http.generateCalls();
      const classifyBeforeStop = http.classifyCalls();

      service.ingestSegment(CID, segment(U2, 1));
      await service.stop(CID, { persistSnapshot: false });

      expect(http.generateCalls(), 'stop() issued a text /generate call').toBe(generateBeforeStop);
      expect(http.classifyCalls(), 'stop() did not run NER over the tail').toBe(classifyBeforeStop + 1);
      expect(http.classifyTexts.at(-1)).toBe(U2);

      const closed = cache.published.find((p) => p.closed === true);
      expect(closed, 'no closing frame was published').toBeDefined();
      expect(closed!.runningSummary).toBe(first!.runningSummary);
      expect(closed!.sections).toEqual(first!.sections);
      expect(texts(closed)).toEqual(expect.arrayContaining(['cough', 'metformin']));
      expect(closed!.entities.find((e) => e.text === 'metformin')).toMatchObject({
        transcriptSegmentId: 'utt-1',
        transcriptStart: U2.indexOf('metformin'),
      });
    });
  }

  it('a consultation stopped before its first flush closes with the tail entities on the empty note', async () => {
    const { cache, service } = await open(true);
    service.ingestSegment(CID, segment(U2, 0));
    const finalPayload = await service.stop(CID, { persistSnapshot: false });

    expect(finalPayload).toBeNull();
    const closed = cache.published.find((p) => p.closed === true);
    expect(closed!.runningSummary).toBe('');
    expect(texts(closed)).toEqual(['metformin']);
  });

  it('a NER call that outlives the stop budget is abandoned and the consultation closes as before', async () => {
    const { cache, http, service } = await open(true, { hangClassify: 1 });
    (service as unknown as { STOP_NER_TIMEOUT_MS: number }).STOP_NER_TIMEOUT_MS = 30;
    service.ingestSegment(CID, segment(U1, 0));
    const first = await service.flush(CID);

    service.ingestSegment(CID, segment(U2, 1));
    const startedAt = Date.now();
    await service.stop(CID, { persistSnapshot: false });

    expect(http.classifyCalls()).toBe(2);
    expect(Date.now() - startedAt, 'stop() waited on the hung NER call').toBeLessThan(1_000);
    const closed = cache.published.find((p) => p.closed === true);
    expect(closed, 'no closing frame was published').toBeDefined();
    expect(closed!.runningSummary).toBe(first!.runningSummary);
    expect(texts(closed)).toEqual(texts(first));
  });

  it('a failing NER call at stop closes as before', async () => {
    const { cache, service } = await open(true, { failClassify: 1 });
    service.ingestSegment(CID, segment(U1, 0));
    const first = await service.flush(CID);

    service.ingestSegment(CID, segment(U2, 1));
    await service.stop(CID, { persistSnapshot: false });

    const closed = cache.published.find((p) => p.closed === true);
    expect(closed!.runningSummary).toBe(first!.runningSummary);
    expect(texts(closed)).toEqual(texts(first));
  });
});
