/**
 * TASK-1022 (wave 2, D-FLUSH) — the stop flush was SUPERSEDED by a trailing timer flush, so the
 * transcript spoken after the last generation never reached the note.
 *
 * ## What was measured (replay1020 run3, afternoon revisit, 2026-09-30)
 *
 * - 09:22:03.1 a non-forced generation (gen 3) was in flight when the clinician stopped; a flush
 *   request during it had set `coalescedFlush`.
 * - 09:22:06.6 `stop()` ran its FORCED flush (gen 4). It bypasses the single-flight gate, claims a
 *   new generation and aborts gen 3.
 * - gen 3's `finally` then saw `coalescedFlush` and scheduled the trailing re-run
 *   (`scheduleThrottledFlush`, `minIntervalMs` = 8 s). Nothing in `runStop` cleared it.
 * - 09:22:14.6 the timer fired a NON-forced flush, which claimed gen 5 and aborted gen 4 — the stop
 *   flush — through `isStale()`. `dropStale` returns `null`, the drain loop saw no progress, and the
 *   closing frame was `{"sections":[],"runningSummary":"","closed":true}`. The follow-up ("Come back
 *   in four weeks … emergency department if you get chest pain") was never folded into any section.
 *
 * ## The rule this file pins
 *
 * Once `stop()` has begun, NOTHING may run a generation: no trailing re-run, no idle/throttle timer,
 * no ingest-triggered flush.
 *
 * TASK-1063 1a (owner decision 2026-10-11) — and the stop itself no longer runs one either: it
 * supersedes the generation in flight and closes on the last good note. The transcript spoken after
 * the last generation is the finalizer's (TASK-1045 note plan), which is why the follow-up above is
 * no longer the live lane's to fold.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';

const CID = 'consultation-stop-race-1022';
const TENANT = 'tenant-stop-race-1022';
const NOTE = 'Subjective: patient reports tiredness\nObjective:\nAssessment: anaemia\nPlan: come back in four weeks';
const LATE = 'Come back in four weeks with a repeat hemoglobin and an HbA1c';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-30T00:00:00.000Z',
});

/**
 * A `/generate` mock that honours the abort signal (as axios does) and lets the test hold each call
 * open until it chooses to release it. Every call's prompt is recorded.
 */
function gatedTextHttpMock() {
  const prompts: string[] = [];
  const gates: Array<() => void> = [];
  const started: Array<() => void> = [];
  const startedPromises: Array<Promise<void>> = [];
  for (let i = 0; i < 8; i++) startedPromises.push(new Promise<void>((resolve) => started.push(resolve)));
  let calls = 0;
  const post = vi.fn(async (url: string, body: unknown, config?: { signal?: AbortSignal }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (!url.includes('/generate')) return { data: {} };
    const index = calls++;
    prompts.push(JSON.stringify(body));
    started[index]?.();
    await new Promise<void>((resolve, reject) => {
      gates[index] = resolve;
      config?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })));
    });
    return { data: { summary: NOTE } };
  });
  return {
    axiosRef: { post },
    post,
    prompts,
    callStarted: (index: number) => startedPromises[index],
    release: (index: number) => gates[index]?.(),
    generateCalls: () => calls,
  };
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

function buildService(http: unknown, cache: ReturnType<typeof cacheMock>, env: Record<string, unknown>) {
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TASK-1022 D-FLUSH / TASK-1063 1a — no generation after stop()', () => {
  it('a trailing coalesced re-run scheduled by the superseded in-flight generation never fires after stop', async () => {
    const cache = cacheMock();
    const http = gatedTextHttpMock();
    // A short min interval so a trailing re-run, if one were scheduled, would fire inside the wait.
    const service = buildService(http, cache, { LIVE_DOC_MIN_INTERVAL_MS: '30' });

    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    service.ingestSegment(CID, { text: 'your hemoglobin is 10.2 which is low', isFinal: true, segmentId: 's1' });
    const inFlight = service.flush(CID);
    await http.callStarted(0);

    // A flush requested mid-generation (the idle timer in run3) — recorded as a coalesce.
    void service.flush(CID);
    // The last spoken final lands just before the clinician stops.
    service.ingestSegment(CID, { text: LATE, isFinal: true, segmentId: 's2' });

    const finalPayload = await service.stop(CID, { persistSnapshot: false });
    await inFlight;
    await sleep(120);
    for (let i = 0; i < 6; i++) http.release(i);

    expect(http.generateCalls(), 'a generation ran after stop').toBe(1);
    // Nothing completed before stop, so there is no last good note to close on.
    expect(finalPayload).toBeNull();
    const closed = cache.published.find((p) => p.closed === true);
    expect(closed, 'no closing frame was published').toBeDefined();
  });

  it('a final that lands during the stop starts no generation', async () => {
    const cache = cacheMock();
    const http = gatedTextHttpMock();
    const service = buildService(http, cache, { LIVE_DOC_MIN_INTERVAL_MS: '30' });

    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();
    service.ingestSegment(CID, { text: 'your hemoglobin is 10.2 which is low', isFinal: true, segmentId: 's1' });

    const stopped = service.stop(CID, { persistSnapshot: false });
    // The STT finalize delivers the last final while the stop runs.
    service.ingestSegment(CID, { text: LATE, isFinal: true, segmentId: 's2' });
    await stopped;
    await sleep(80);

    expect(http.generateCalls(), 'the stop or the late final started a generation').toBe(0);
  });
});
