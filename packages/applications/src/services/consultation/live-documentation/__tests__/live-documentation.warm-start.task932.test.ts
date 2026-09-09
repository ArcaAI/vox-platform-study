/**
 * TASK-932 D-9 — the WARM START: an `onStart` node of the graph, run once when the session opens.
 *
 * ## What the owner's journey needs, and what used to happen
 *
 * "previous case notes → pre-summary while recording starts". Until this ticket the pre-summary
 * was reachable only through `POST /consultations/:id/pre-summary` — a call the console had to
 * make itself, at a moment it chose, with no workflow governing whether it happened at all. The
 * consultation graph said nothing about the one step the clinician sees first.
 *
 * ## What this suite pins
 *
 *  1. a graph that authors `n_presummary` runs it ONCE at `start()`, and publishes
 *     `running` → `ready` on the same live channel the case note streams on;
 *  2. it runs BESIDE the capture session, not before it — `start()` returns synchronously and a
 *     flush is not blocked by, and does not re-run, the warm start;
 *  3. a graph with NO warm start publishes nothing at all, so this is additive for every lane
 *     authored before the cadence existed;
 *  4. every failure mode is an OBSERVABLE degrade with a PHI-safe reason — a runner that is not
 *     wired, a first-ever visit with no prior record, a model that fell over. The one thing that
 *     must never happen is the panel resolving to nothing, which is the skeleton-forever defect
 *     TASK-891 B5 fixed for the case note and this would otherwise re-introduce;
 *  5. an `enabled: false` warm start publishes NOTHING — the tenant switched it off, which is not
 *     the same as it having gone wrong.
 */
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import type { LivePreSummaryResult } from '../live-pre-summary.port';

const TENANT = 'tenant-warm-start';
const CID = 'consultation-warm-001';
const SLUG = 'arcaai-gen-consultation';

/** A compiled graph with a capture node and (optionally) a warm start. */
function compiledGraph(options: { warmStart?: { enabled?: boolean } | null } = {}) {
  const warmStart =
    options.warmStart === null
      ? []
      : [
          {
            nodeId: 'n_presummary',
            type: 'core.agent',
            config: {
              agentRef: { slug: 'case-notes-pre-summary' },
              execution: { lane: 'realtime', cadence: 'onStart' },
              onError: 'degrade',
              ...(options.warmStart?.enabled === false ? { enabled: false } : {}),
            },
            inputs: [],
          },
        ];
  return {
    slug: SLUG,
    versionNumber: 1,
    stages: [
      { stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', config: {}, inputs: [] }] },
      {
        stageIndex: 1,
        nodes: [
          {
            nodeId: 'n_asr',
            type: 'core.agent',
            config: { agentRef: { task: 'SPEECH_TO_TEXT' }, execution: { lane: 'realtime', cadence: 'perTurn' } },
            inputs: [],
          },
          ...warmStart,
        ],
      },
      {
        stageIndex: 2,
        nodes: [
          {
            nodeId: 'n_summary',
            type: 'core.agent',
            config: { agentRef: { task: 'TEXT_GENERATION' }, execution: { lane: 'realtime', cadence: 'perTurn' } },
            inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }],
          },
        ],
      },
    ],
  };
}

interface Wiring {
  warmStart?: { enabled?: boolean } | null;
  /** `null` ⇒ the runner is not wired at all. */
  result?: LivePreSummaryResult | null;
}

function buildService(wiring: Wiring = {}) {
  const published: string[] = [];
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_channel: string, message: string) => {
      published.push(message);
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
    return Promise.resolve({ data: { summary: 'Subjective: cough\nObjective:\nAssessment:\nPlan:' } });
  });
  const runner =
    wiring.result === null
      ? undefined
      : { run: vi.fn().mockResolvedValue(wiring.result ?? { status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)' }) };

  const args: unknown[] = new Array(26).fill(undefined);
  args[0] = { axiosRef: { post }, post };
  args[1] = { get: vi.fn((key: string) => (key === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) };
  args[2] = cache;
  // A per-channel Subject-backed subscriber: enough for `subscribeToLiveSummary` to relay, and
  // it lets a test publish onto the live channel the way Redis would.
  const channels = new Map<string, Subject<string>>();
  const channelSubject = (channel: string): Subject<string> => {
    const existing = channels.get(channel);
    if (existing) return existing;
    const created = new Subject<string>();
    channels.set(channel, created);
    return created;
  };
  args[3] = {
    subscribeToChannel: vi.fn(async (channel: string) => channelSubject(channel).asObservable()),
    unsubscribeFromChannel: vi.fn(),
  };
  args[6] = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) };
  args[9] = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  args[15] = { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null })) };
  args[16] = { resolve: vi.fn(async () => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) };
  args[17] = { findPublishedBySlug: vi.fn(async () => ({ slug: SLUG, compiledConfig: compiledGraph(wiring) })) };
  args[25] = runner;

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, published, runner, post, cache, channelSubject };
}

/** Every `presummary` event published, in order. */
function preSummaryEvents(published: string[]) {
  return published
    .map((raw) => {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event?.event === 'presummary');
}

/** Start a session and let the fire-and-forget warm start settle. */
async function startAndSettle(service: LiveDocumentationService) {
  service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
  // `onStartPromise` is held on the session precisely so a test can await it rather than sleep.
  await (service as unknown as { sessions: Map<string, { onStartPromise?: Promise<void> }> }).sessions.get(CID)!.onStartPromise;
}

describe('TASK-932 D-9 — the warm start runs once when the session opens', () => {
  it('publishes `running` then `ready`, carrying the pre-summary and the agent the graph named', async () => {
    const { service, published, runner } = buildService();

    await startAndSettle(service);

    const events = preSummaryEvents(published);
    expect(events.map((event) => event.status)).toEqual(['running', 'ready']);
    expect(events[1]).toMatchObject({
      consultationId: CID,
      status: 'ready',
      content: '- Diabetes (recorded 11-Aug-2026)',
      agentSlug: 'case-notes-pre-summary',
    });
    expect(typeof events[1]!.updatedAt).toBe('string');

    // The graph decides WHICH agent; the runner is told, and is given the session's own tenant
    // and clinician rather than re-deriving them from an ambient context.
    expect(runner!.run).toHaveBeenCalledTimes(1);
    expect(runner!.run).toHaveBeenCalledWith({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1', agentSlug: 'case-notes-pre-summary' });
  });

  it('runs BESIDE the capture session: `start()` is synchronous and a flush neither waits for it nor re-runs it', async () => {
    const { service, published, runner, post } = buildService();

    // `start()` returns before the warm start has run — the microphone never waits on an LLM call
    // over the patient's whole prior record.
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    expect(preSummaryEvents(published).filter((event) => event.status === 'ready')).toHaveLength(0);

    await (service as unknown as { sessions: Map<string, { onStartPromise?: Promise<void> }> }).sessions.get(CID)!.onStartPromise;
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    // ONCE, across two flushes. A warm-start node left in the flush lane would be three.
    expect(runner!.run).toHaveBeenCalledTimes(1);
    // …and the flushes still generated: the partition removes the warm start, not the note.
    expect(post.mock.calls.filter((call) => String(call[0]).includes('/generate')).length).toBeGreaterThan(0);
  });

  it('a graph with NO warm start publishes no `presummary` event at all', async () => {
    const { service, published, runner } = buildService({ warmStart: null });

    await startAndSettle(service);

    expect(preSummaryEvents(published)).toEqual([]);
    expect(runner!.run).not.toHaveBeenCalled();
  });

  it('an `enabled: false` warm start publishes NOTHING — switched off is not gone wrong', async () => {
    const { service, published, runner } = buildService({ warmStart: { enabled: false } });

    await startAndSettle(service);

    expect(preSummaryEvents(published)).toEqual([]);
    expect(runner!.run).not.toHaveBeenCalled();
  });

  it('a first-ever visit degrades with `no_case_notes` — a fact about the patient, not a failure', async () => {
    const { service, published } = buildService({ result: { status: 'degraded', reason: 'no_case_notes' } });

    await startAndSettle(service);

    const events = preSummaryEvents(published);
    expect(events.map((event) => event.status)).toEqual(['running', 'degraded']);
    expect(events[1]).toMatchObject({ status: 'degraded', error: 'no_case_notes' });
    expect(events[1]!.content).toBeUndefined();
  });

  it('an UNWIRED runner still resolves the panel — `warm_start_unwired`, never a skeleton forever', async () => {
    const { service, published } = buildService({ result: null });

    await startAndSettle(service);

    const events = preSummaryEvents(published);
    expect(events.map((event) => event.status)).toEqual(['running', 'degraded']);
    expect(events[1]).toMatchObject({ error: 'warm_start_unwired' });
  });

  it('never overwrites the snapshot cache — the pre-summary must not replace the running note', async () => {
    const { service, cache, published } = buildService();

    await startAndSettle(service);

    // The events DID publish…
    expect(preSummaryEvents(published)).toHaveLength(2);
    // …through `safeChannelPublish`, which writes no WHOLE-DOCUMENT snapshot. `safePublish` (the
    // whole-document path) writes one, and a client reconnecting mid-consultation asks that cache
    // for the NOTE — answering with a pre-summary would replace the clinician's document with its
    // background material. The pre-summary gets its own key instead (L-1, below); what must never
    // happen is a write to `:last`.
    expect(cache.setex.mock.calls.map((call) => call[0])).not.toContain(`consultation:live-summary:${CID}:last`);
  });
});

/**
 * TASK-932 wave 4 L-1 — the warm start must survive a LATE JOIN.
 *
 * `publishPreSummary` deliberately does not touch the whole-document snapshot cache (the test
 * directly above pins that), and until this item it wrote no cache at all — so a `running` /
 * `degraded` event published before the console's SSE stream subscribed was lost forever. That is
 * not hypothetical: on the merged wave-3 tree the warm start degraded at **+29 ms** and the
 * console subscribed at **+56 ms**, and the panel never appeared.
 *
 * The fix is a companion key, `…:presummary:last`, on the same `SNAPSHOT_TTL` as the note
 * snapshot, replayed to a late joiner AFTER the whole-document snapshot. Order matters: the note
 * is the primary document and must paint first; the pre-summary is its background material.
 */
describe('TASK-932 L-1 — a pre-summary published before the stream opens is replayed on late join', () => {
  const PRESUMMARY_KEY = `consultation:live-summary:${CID}:presummary:last`;
  const SNAPSHOT_KEY = `consultation:live-summary:${CID}:last`;
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  it('`publishPreSummary` caches the event under `:presummary:last` alongside the publish', async () => {
    const { service, cache, published } = buildService();

    await startAndSettle(service);

    const cached = cache.setex.mock.calls.filter((call) => call[0] === PRESUMMARY_KEY);
    // One write per published event — the LAST one is what a late joiner is owed.
    expect(cached).toHaveLength(2);
    // 1h, the same TTL the note snapshot carries: a transient late-join aid, never a store.
    expect(cached[0]![1]).toBe(3600);
    // Byte-identical to what went on the wire — a late joiner and a live one see the same JSON.
    expect(cached.map((call) => call[2])).toEqual(preSummaryEvents(published).map((event) => JSON.stringify(event)));
  });

  it('a late subscriber is replayed the last pre-summary event', async () => {
    const { service, cache } = buildService();
    const cached: Record<string, string> = {};
    cache.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
      cached[key] = value;
    });
    cache.get.mockImplementation(async (key: string) => cached[key] ?? null);

    await startAndSettle(service);

    const events: Array<{ data: string }> = [];
    const sub = service.subscribeToLiveSummary(CID).subscribe((event: unknown) => events.push(event as { data: string }));
    await tick();

    expect(events.map((event) => JSON.parse(event.data) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ event: 'presummary', status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)' }),
    ]);
    sub.unsubscribe();
  });

  it('a late subscriber sees the whole-document snapshot FIRST, then the pre-summary', async () => {
    const { service, cache } = buildService();
    const cached: Record<string, string> = {};
    cache.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
      cached[key] = value;
    });
    cache.get.mockImplementation(async (key: string) => cached[key] ?? null);
    // A note snapshot already exists — the clinician has been recording for a while.
    cached[SNAPSHOT_KEY] = JSON.stringify({
      consultationId: CID,
      runningSummary: 'S: cough',
      sections: [],
      entities: [],
      updatedAt: '2026-09-09T00:00:00.000Z',
    });

    await startAndSettle(service);

    const events: Array<{ data: string }> = [];
    const sub = service.subscribeToLiveSummary(CID).subscribe((event: unknown) => events.push(event as { data: string }));
    await tick();

    const parsed = events.map((event) => JSON.parse(event.data) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ runningSummary: 'S: cough' });
    expect(parsed[0]!.event).toBeUndefined();
    expect(parsed[1]).toMatchObject({ event: 'presummary', status: 'ready' });
    sub.unsubscribe();
  });

  it('an absent cache replays NOTHING — a consultation with no warm start opens on an empty stream', async () => {
    const { service, cache } = buildService();
    cache.get.mockResolvedValue(null);

    const events: Array<{ data: string }> = [];
    const sub = service.subscribeToLiveSummary(CID).subscribe((event: unknown) => events.push(event as { data: string }));
    await tick();

    expect(events).toEqual([]);
    sub.unsubscribe();
  });

  it('a LIVE pre-summary is not dropped as a duplicate of a same-instant note snapshot — the dedupe is per event kind', async () => {
    const { service, cache, channelSubject } = buildService();
    const at = '2026-09-09T00:00:05.000Z';
    cache.get.mockImplementation(async (key: string) =>
      key === SNAPSHOT_KEY ? JSON.stringify({ consultationId: CID, runningSummary: 'note', sections: [], entities: [], updatedAt: at }) : null,
    );
    const events: Array<{ data: string }> = [];
    const sub = service.subscribeToLiveSummary(CID).subscribe((event: unknown) => events.push(event as { data: string }));
    await tick();

    // Same `updatedAt` as the note snapshot, but a DIFFERENT kind of event. Dedupe keyed on the
    // snapshot alone would silently swallow it, which is the warm-start panel going dark again.
    channelSubject(`consultation:live-summary:${CID}`).next(
      JSON.stringify({ event: 'presummary', consultationId: CID, status: 'ready', content: 'x', updatedAt: at }),
    );
    await tick();

    expect(events.map((event) => (JSON.parse(event.data) as { event?: string }).event)).toEqual([undefined, 'presummary']);
    sub.unsubscribe();
  });
});

/**
 * TASK-932 wave 4 L2 F-8 — the pre-summary dedupe must not swallow a same-millisecond successor.
 *
 * L-1's dedupe compares `updatedAt <= emittedUpdatedAt`, which is the right rule for the
 * whole-document note: its snapshot IS its state, so an older or equal one carries nothing new.
 * The `presummary` lifecycle is not a document — it is a sequence of STATUSES (`running` →
 * `ready` / `degraded`) — and `publishPreSummary` stamps `new Date().toISOString()`, a
 * MILLISECOND clock, then caches before publishing. Two events separated only by a Redis
 * round-trip routinely share a millisecond, and on a warm Redis the whole `running` → `degraded`
 * pair can.
 *
 * The consequence is the exact defect L-1 exists to prevent, one step later: a late joiner is
 * replayed `running`, the live terminal event is dropped as a "duplicate", and the panel spins
 * forever on a warm start that already finished.
 *
 * For this kind the cache is a BYTE-IDENTICAL copy of what was published, so identity is both
 * the correct test and an exact one: the replayed event is dropped, everything else is relayed.
 */
describe('TASK-932 L2 F-8 — a same-millisecond pre-summary successor is relayed, not deduped', () => {
  const PRESUMMARY_KEY = `consultation:live-summary:${CID}:presummary:last`;
  const CHANNEL = `consultation:live-summary:${CID}`;
  const AT = '2026-09-09T00:00:07.000Z';
  const RUNNING = JSON.stringify({ event: 'presummary', consultationId: CID, status: 'running', agentSlug: 'case-notes-pre-summary', updatedAt: AT });
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A late joiner whose replay is the cached `running` event and nothing else. */
  async function lateJoiner() {
    const { service, cache, channelSubject } = buildService();
    cache.get.mockImplementation(async (key: string) => (key === PRESUMMARY_KEY ? RUNNING : null));
    const events: Array<{ data: string }> = [];
    const sub = service.subscribeToLiveSummary(CID).subscribe((event: unknown) => events.push(event as { data: string }));
    await tick();
    expect(events).toHaveLength(1);
    return { events, channelSubject, sub, tick };
  }

  it('relays a `degraded` stamped in the same millisecond as the replayed `running`', async () => {
    const { events, channelSubject, sub } = await lateJoiner();

    channelSubject(CHANNEL).next(
      JSON.stringify({ event: 'presummary', consultationId: CID, status: 'degraded', error: 'no_case_notes', updatedAt: AT }),
    );
    await tick();

    // Dropping this is the warm-start panel spinning forever on a run that already finished.
    expect(events.map((event) => (JSON.parse(event.data) as { status?: string }).status)).toEqual(['running', 'degraded']);
    sub.unsubscribe();
  });

  it('still drops the REPLAYED event when the channel re-delivers it byte for byte', async () => {
    const { events, channelSubject, sub } = await lateJoiner();

    channelSubject(CHANNEL).next(RUNNING);
    await tick();

    // The replay is what the dedupe exists for: a late joiner must not render `running` twice.
    expect(events).toHaveLength(1);
    sub.unsubscribe();
  });

  it('relays a `ready` that differs only in its CONTENT from the replayed event', async () => {
    const { events, channelSubject, sub } = await lateJoiner();

    channelSubject(CHANNEL).next(JSON.stringify({ event: 'presummary', consultationId: CID, status: 'running', agentSlug: 'other', updatedAt: AT }));
    await tick();

    expect(events).toHaveLength(2);
    sub.unsubscribe();
  });
});

/**
 * TASK-932 wave 4 L2 F-9 — the pre-summary replay key is a SESSION's key, and stop ends it.
 *
 * `…:presummary:last` carries `SNAPSHOT_TTL` (1 h) for the same reason the note snapshot does: a
 * late joiner of a LIVE session is owed what it missed. Nothing cleared it at stop, so a
 * consultation reopened inside that hour replayed the PREVIOUS session's warm start to its next
 * late joiner — background material about a visit that already ended, rendered beside a note it
 * has nothing to do with.
 *
 * `…:last` deliberately survives: its final write is the terminal `closed: true` payload, which
 * is exactly what a late joiner of a CLOSED consultation should see (and what
 * `closedFlagTerminal` needs to complete their stream). The pre-summary has no terminal form —
 * it is only ever mid-session state — so it is deleted, not preserved.
 */
describe('TASK-932 L2 F-9 — stop clears the pre-summary replay key', () => {
  const PRESUMMARY_KEY = `consultation:live-summary:${CID}:presummary:last`;
  const SNAPSHOT_KEY = `consultation:live-summary:${CID}:last`;

  it('deletes `:presummary:last` when the owning instance stops the session', async () => {
    const { service, cache } = buildService();
    await startAndSettle(service);
    expect(cache.setex.mock.calls.some((call) => call[0] === PRESUMMARY_KEY)).toBe(true);

    await service.stop(CID);

    expect(cache.del.mock.calls.map((call) => call[0])).toContain(PRESUMMARY_KEY);
  });

  it('deletes it even when the stop is routed to an instance that owns no session', async () => {
    // The cross-instance path: `clearStats` already runs here for the same reason, and a warm
    // start cached by the OWNER is just as stale for the next session either way.
    const { service, cache } = buildService();

    await service.stop(CID);

    expect(cache.del.mock.calls.map((call) => call[0])).toContain(PRESUMMARY_KEY);
  });

  it('leaves the whole-document `:last` snapshot alone — its terminal `closed` is what a late joiner of a finished consultation is owed', async () => {
    const { service, cache } = buildService();
    await startAndSettle(service);

    await service.stop(CID);

    expect(cache.del.mock.calls.map((call) => call[0])).not.toContain(SNAPSHOT_KEY);
  });
});
