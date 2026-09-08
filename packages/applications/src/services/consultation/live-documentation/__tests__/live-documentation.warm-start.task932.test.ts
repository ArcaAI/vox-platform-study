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
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import type { LivePreSummaryResult } from '../live-pre-summary.port';

const TENANT = 'tenant-warm-start';
const CID = 'consultation-warm-001';
const SLUG = 'arcaai-gen-consultation';

/** A compiled graph with a capture node and (optionally) a warm start. */
function compiledGraph(options: { warmStart?: { enabled?: boolean } | null } = {}) {
  const warmStart = options.warmStart === null ? [] : [
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
          { nodeId: 'n_asr', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' }, execution: { lane: 'realtime', cadence: 'perTurn' } }, inputs: [] },
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
  const runner = wiring.result === null ? undefined : { run: vi.fn().mockResolvedValue(wiring.result ?? { status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)' }) };

  const args: unknown[] = new Array(26).fill(undefined);
  args[0] = { axiosRef: { post }, post };
  args[1] = { get: vi.fn((key: string) => (key === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
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
  return { service, published, runner, post, cache };
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
    // …through `safeChannelPublish`, which writes no snapshot. `safePublish` (the whole-document
    // path) writes one, and a client reconnecting mid-consultation asks that cache for the NOTE —
    // answering with a pre-summary would replace the clinician's document with its background
    // material.
    expect(cache.setex).not.toHaveBeenCalled();
  });
});
