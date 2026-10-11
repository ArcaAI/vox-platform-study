/**
 * TASK-1063 1a / 1b — the live lane runs no generation at stop, and the first flush of a recording
 * fires within ~20 s of transcribed speech.
 *
 * ## 1a — what was measured (TASK-1062 AC4, ×3)
 *
 * At stop every consultation's forced live flush reached the 2-slot live lane at once; 2 of 3 waited
 * ~31 s and answered 503 `CONCURRENCY_LIMIT`. Those generations bought nothing: finalization runs
 * right after stop and writes the note from the transcript record (TASK-1045 note plan), not from
 * the live text. Owner decision 2026-10-11: no live flush on stop.
 *
 * ## The rule pinned here
 *
 * `stop()` issues NO text `/generate` call. It supersedes (aborts) a generation still in flight, so
 * the slot is freed at once, and publishes the terminal `closed` snapshot carrying the LAST GOOD note
 * — with a fresh `updatedAt`, so a late joiner that was replayed that note does not de-duplicate the
 * terminal away.
 *
 * ## 1b — the first-flush gates (agentic-context descriptors)
 *
 * The first flush of a session starts at min(first final + `liveFlush.idleMs`, the
 * `liveFlush.segmentThreshold`-th final); `liveFlush.minIntervalMs` cannot hold it back because
 * `lastFlushAt` starts at 0. With the ml-en 7 s finals that is the idle timer at ~17 s.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import { AGENTIC_CONTEXT_DEFAULTS } from '../../../settings-registry/descriptors/agentic-context.descriptors';

const CID = 'consultation-stop-1063';
const TENANT = 'tenant-stop-1063';
const NOTE = 'Subjective: patient reports tiredness\nObjective:\nAssessment: anaemia\nPlan: repeat hemoglobin';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-10-11T00:00:00.000Z',
});

/** A `/generate` mock that honours the abort signal and can hold a call open until released. */
function textHttpMock(options: { hold?: boolean } = {}) {
  const gates: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  let startedResolve: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => (startedResolve = resolve));
  let calls = 0;
  const post = vi.fn(async (url: string, _body: unknown, config?: { signal?: AbortSignal }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (!url.includes('/generate')) return { data: {} };
    const index = calls++;
    if (config?.signal) signals.push(config.signal);
    startedResolve();
    if (options.hold) {
      await new Promise<void>((resolve, reject) => {
        gates[index] = resolve;
        config?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })));
      });
    }
    return { data: { summary: NOTE } };
  });
  return { axiosRef: { post }, post, signals, firstStarted, release: (i: number) => gates[i]?.(), generateCalls: () => calls };
}

function cacheMock() {
  const published: Array<Record<string, unknown>> = [];
  return {
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_channel: string, raw: string) => {
      try {
        published.push(JSON.parse(raw) as Record<string, unknown>);
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

function buildService(http: unknown, cache: ReturnType<typeof cacheMock>, env: Record<string, unknown> = {}, graph = true) {
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: graph, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  return new LiveDocumentationService(
    http as never,
    configService as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    effectiveSettings as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
  );
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('TASK-1063 1a — stop() runs no live generation', () => {
  for (const graph of [true, false]) {
    it(`${graph ? 'graph' : 'legacy'} lane: no /generate at stop; the closing frame carries the last good note`, async () => {
      const cache = cacheMock();
      const http = textHttpMock();
      const service = buildService(http, cache, { LIVE_DOC_MIN_INTERVAL_MS: '0' }, graph);
      service.start({ consultationId: CID, tenantId: TENANT });
      await tick();

      service.ingestSegment(CID, { text: 'your hemoglobin is 10.2 which is low', isFinal: true, segmentId: 's1' });
      const lastGood = await service.flush(CID);
      expect(lastGood?.runningSummary, 'the flush produced no note to carry').toBeTruthy();
      const callsBeforeStop = http.generateCalls();

      // Transcript spoken after the last generation: finalization owns it, the live lane does not.
      service.ingestSegment(CID, { text: 'come back in four weeks with a repeat hemoglobin', isFinal: true, segmentId: 's2' });
      const finalPayload = await service.stop(CID, { persistSnapshot: false });

      expect(http.generateCalls(), 'stop() issued a text /generate call').toBe(callsBeforeStop);
      expect(finalPayload?.runningSummary).toBe(lastGood?.runningSummary);
      const closed = cache.published.find((p) => p.closed === true) as
        { sections?: unknown[]; runningSummary?: string; updatedAt?: string } | undefined;
      expect(closed, 'no closing frame was published').toBeDefined();
      expect(closed?.runningSummary).toBe(lastGood?.runningSummary);
      expect(closed?.sections).toEqual(lastGood?.sections);
      // A fresh clock: a late joiner replayed the last note must not de-duplicate the terminal away.
      expect(closed?.updatedAt).not.toBe(lastGood?.updatedAt);
    });
  }

  it('a generation in flight at stop is aborted (the live slot is freed) and none replaces it', async () => {
    const cache = cacheMock();
    const http = textHttpMock({ hold: true });
    const service = buildService(http, cache, { LIVE_DOC_MIN_INTERVAL_MS: '0' });
    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    service.ingestSegment(CID, { text: 'your hemoglobin is 10.2 which is low', isFinal: true, segmentId: 's1' });
    const inFlight = service.flush(CID);
    await http.firstStarted;

    const finalPayload = await service.stop(CID, { persistSnapshot: false });
    await inFlight;

    expect(http.signals[0]?.aborted, 'the in-flight live generation was not aborted at stop').toBe(true);
    expect(http.generateCalls(), 'stop() started a generation of its own').toBe(1);
    expect(finalPayload).toBeNull();
    const closed = cache.published.find((p) => p.closed === true);
    expect(closed, 'no closing frame was published').toBeDefined();
  });
});

describe('TASK-1063 1b — the first flush fires within ~20 s of transcribed speech', () => {
  it('the first-flush gate defaults', () => {
    expect(AGENTIC_CONTEXT_DEFAULTS['liveFlush.idleMs']).toBe(10_000);
    expect(AGENTIC_CONTEXT_DEFAULTS['liveFlush.segmentThreshold']).toBe(6);
    expect(AGENTIC_CONTEXT_DEFAULTS['liveFlush.minIntervalMs']).toBe(8_000);
  });

  it('with the default gates, 7 s finals (ml-en) start the first generation by 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cache = cacheMock();
    const http = textHttpMock();
    // No env overrides: the code defaults decide.
    const service = buildService(http, cache);
    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    // Finals land at 7 s, 14 s (and would at 21 s): fewer than `segmentThreshold`, so the idle
    // timer armed by the FIRST final decides.
    await vi.advanceTimersByTimeAsync(7_000);
    service.ingestSegment(CID, { text: 'patient reports tiredness for two weeks', isFinal: true, segmentId: 's1' });
    await vi.advanceTimersByTimeAsync(7_000);
    service.ingestSegment(CID, { text: 'hemoglobin is 10.2 which is low', isFinal: true, segmentId: 's2' });
    await vi.advanceTimersByTimeAsync(6_000); // t = 20 s
    for (let i = 0; i < 5; i++) await tick();

    expect(http.generateCalls(), 'no live generation had started 20 s into the recording').toBeGreaterThan(0);
    vi.useRealTimers();
    await service.stop(CID, { persistSnapshot: false });
  });

  it('with the default gates, short dialogue finals start the first generation well before 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cache = cacheMock();
    const http = textHttpMock();
    const service = buildService(http, cache);
    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    // ~11 utterances in 35 s (TASK-1062 AC4): a final every ~3.2 s.
    for (let i = 0; i < 6 && http.generateCalls() === 0; i++) {
      await vi.advanceTimersByTimeAsync(3_200);
      service.ingestSegment(CID, { text: `utterance ${i} about the cough`, isFinal: true, segmentId: `s${i}` });
      for (let k = 0; k < 5; k++) await tick();
    }
    expect(http.generateCalls(), 'the 6th final (~19 s) did not start a generation').toBeGreaterThan(0);
    vi.useRealTimers();
    await service.stop(CID, { persistSnapshot: false });
  });
});
