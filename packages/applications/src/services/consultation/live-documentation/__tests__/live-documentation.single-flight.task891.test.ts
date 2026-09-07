/**
 * TASK-891 B2/B3 — FIELD DEFECT: the flush loop starved itself.
 *
 * ## What was measured (consultation `01a07ae9-2497-…`, `hope-v2-dev`, 2026-09-07)
 *
 * A 10½-minute recording produced **55 flush generations, 53 dropped by `isStale()`,
 * 2 completed**, and both survivors published zero sections. `core."DocumentSection"`
 * held 0 rows cluster-wide.
 *
 * ## Why
 *
 * `flush()` claimed a NEW generation and aborted the previous one on EVERY entry
 * (`++session.generation` + `abortController.abort()`), and the min-interval throttle
 * measures from the previous flush's START. A realtime SOAP generation takes 14 s on an
 * idle cluster and 20–52 s under load, against a 4 s min interval — so every transcript
 * delta superseded a generation that was still running, and the one that would have
 * published was aborted a few seconds before it returned. The engine was busy
 * continuously and produced nothing.
 *
 * ## The rule this file pins
 *
 * **One generation in flight per session.** A flush requested while another is running
 * COALESCES into a trailing re-run instead of starting a competing generation, so a slow
 * model degrades the CADENCE and never the OUTPUT. `isStale()` is retained for genuine
 * supersession — a `force`d final flush from `stop()`, or the session being replaced.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveDocSessionStatsResponse } from '../dto/live-doc-admin.dto';

const CID = 'consultation-single-flight-001';
const TENANT = 'tenant-single-flight-001';
const NOTE = 'Subjective: patient reports cough\nObjective:\nAssessment:\nPlan:';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-07T00:00:00.000Z',
});

/** A `/generate` mock whose FIRST call blocks until `release()` — the slow model. */
function slowTextHttpMock() {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstCallStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      calls += 1;
      if (calls === 1) {
        started();
        await blocked;
      }
      return { data: { summary: NOTE } };
    }
    return { data: {} };
  });
  return { axiosRef: { post }, post, release: () => release(), firstCallStarted };
}

function cacheMock() {
  const stats: LiveDocSessionStatsResponse[] = [];
  const published: string[] = [];
  return {
    stats,
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      if (key.startsWith('live-doc:stats:')) stats.push(JSON.parse(raw) as LiveDocSessionStatsResponse);
    }),
    publish: vi.fn(async (_channel: string, raw: string) => {
      published.push(raw);
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

function buildService(http: unknown, cache: ReturnType<typeof cacheMock>) {
  // Min interval 0: the throttle must not be what saves this test — the
  // single-flight gate has to.
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
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

describe('TASK-891 B3 — the realtime flush is single-flight per session', () => {
  it('a flush requested while a generation is in flight coalesces instead of superseding it', async () => {
    const cache = cacheMock();
    const slow = slowTextHttpMock();
    const service = buildService(slow, cache);

    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();

    service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });
    const first = service.flush(CID);

    // Wait until the slow generation is genuinely in flight before racing it.
    await slow.firstCallStarted;

    // A new transcript delta arrives mid-generation — exactly what happened 53 times.
    service.ingestSegment(CID, { text: 'and a mild fever', isFinal: true, segmentId: 's2' });
    const second = service.flush(CID);

    slow.release();
    const firstPayload = await first;
    await second;
    await tick();

    expect(firstPayload, 'the in-flight generation was aborted by a competing flush and published nothing').not.toBeNull();
    expect(cache.stats.length, 'no flush ever completed, so no stats snapshot was published').toBeGreaterThan(0);
    expect(
      cache.stats[cache.stats.length - 1].staleDropCount,
      'the only in-flight generation was discarded as stale — a slow model must degrade CADENCE, not produce nothing',
    ).toBe(0);

    await service.stop(CID, { persistSnapshot: false });
  });

  it('a forced flush (stop) still supersedes an in-flight generation', async () => {
    const cache = cacheMock();
    const slow = slowTextHttpMock();
    const service = buildService(slow, cache);

    service.start({ consultationId: CID, tenantId: TENANT });
    await tick();
    service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });

    const first = service.flush(CID);
    await slow.firstCallStarted;

    // `force` is the final-flush path: it must NOT be coalesced away, because there
    // is no later flush to coalesce into.
    const forced = service.flush(CID, { force: true });
    slow.release();

    await Promise.all([first, forced]);
    expect(slow.post.mock.calls.filter((c) => String(c[0]).includes('/generate')).length).toBeGreaterThanOrEqual(2);

    await service.stop(CID, { persistSnapshot: false });
  });
});
