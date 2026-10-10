/**
 * TASK-1059 RC-7 / D-08 — the warm-start pre-summary reaches the client before `closed`, and a
 * degraded note is never persisted as a PRE_SUMMARY item.
 *
 * ## RC-7
 *
 * The warm start runs beside the capture session. In TASK-1058 it finished 67 s AFTER the live plane
 * had published `summary.snapshot closed: true`; every SDK and the ALaaS broker stop reading at
 * `closed`, so a pre-summary that was generated and persisted (1 502 chars) was never shown.
 *
 * Route chosen: `stop()` waits — BOUNDED — for the session's `onStart` nodes to settle before it
 * publishes the terminal `closed` payload. Including the pre-summary in the closing snapshot alone
 * would not have fixed the observed case: the pre-summary did not EXIST yet when `closed` was sent.
 * The wait costs nothing when there is no warm start or it already settled, and it is bounded so a
 * hung warm start can never hold a stop open.
 *
 * ## D-08
 *
 * With a document template, `buildStructuredSummary([])` renders every heading over the "not
 * documented" marker. A flush that produced no note (all TEXT calls failed) therefore wrote a
 * headings-only LIVE_SOAP_SNAPSHOT row as an ordinary PRE_SUMMARY item, which the finalizer then read
 * as "the live note". A note with no section body is not persisted.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import type { LivePreSummaryResult } from '../live-pre-summary.port';

const TENANT = 'tenant-1059-presummary';
const CID = 'consultation-1059-presummary';
const SLUG = 'arcaai-gen-consultation';

function compiledGraph() {
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
          {
            nodeId: 'n_presummary',
            type: 'core.agent',
            config: { agentRef: { slug: 'case-notes-pre-summary' }, execution: { lane: 'realtime', cadence: 'onStart' }, onError: 'degrade' },
            inputs: [],
          },
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

function buildService(options: { run: () => Promise<LivePreSummaryResult>; textFails?: boolean; contextItems?: unknown }) {
  const published: Record<string, unknown>[] = [];
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_channel: string, message: string) => {
      try {
        published.push(JSON.parse(message) as Record<string, unknown>);
      } catch {
        // not a JSON frame
      }
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate') && options.textFails) throw new Error('Request failed with status code 502');
    return { data: { summary: JSON.stringify({ subjective: { addition: 'Cough for three days.' }, objective: null, assessment: null, plan: null }) } };
  });
  const args: unknown[] = new Array(26).fill(undefined);
  args[0] = { axiosRef: { post }, post };
  args[1] = { get: vi.fn((key: string) => (key === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[5] = options.contextItems;
  args[6] = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) };
  args[7] = { encrypt: vi.fn(async () => 'cipher'), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') };
  args[9] = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  args[15] = { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null })) };
  args[16] = { resolve: vi.fn(async () => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) };
  args[17] = { findPublishedBySlug: vi.fn(async () => ({ slug: SLUG, compiledConfig: compiledGraph() })) };
  args[25] = { run: vi.fn(options.run) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, published };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('TASK-1059 RC-7 — the terminal snapshot waits for the warm start', () => {
  it('a pre-summary that finishes DURING stop is published before `closed`', async () => {
    let release: ((result: LivePreSummaryResult) => void) | undefined;
    const { service, published } = buildService({
      run: () =>
        new Promise<LivePreSummaryResult>((resolve) => {
          release = resolve;
        }),
    });
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    while (!release) await tick();

    const stopping = service.stop(CID);
    // The stop has drained and torn down; the warm start is still running.
    for (let i = 0; i < 20; i++) await tick();
    expect(published.some((frame) => frame.closed === true), '`closed` went out while the warm start was still running').toBe(false);

    release({ status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)' });
    await stopping;

    const readyAt = published.findIndex((frame) => frame.event === 'presummary' && frame.status === 'ready');
    const closedAt = published.findIndex((frame) => frame.closed === true);
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeGreaterThan(readyAt);
  });

  it('a degraded warm start keeps HOPE`s reason code on the event it publishes before `closed`', async () => {
    let release: ((result: LivePreSummaryResult) => void) | undefined;
    const { service, published } = buildService({
      run: () =>
        new Promise<LivePreSummaryResult>((resolve) => {
          release = resolve;
        }),
    });
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    while (!release) await tick();
    const stopping = service.stop(CID);
    release({ status: 'degraded', reason: 'kv_exhausted' });
    await stopping;

    const degradedAt = published.findIndex((frame) => frame.event === 'presummary' && frame.status === 'degraded');
    expect(published[degradedAt]).toMatchObject({ error: 'kv_exhausted' });
    expect(published.findIndex((frame) => frame.closed === true)).toBeGreaterThan(degradedAt);
  });

  it('is BOUNDED: a warm start that never settles cannot hold the stop open', async () => {
    const { service, published } = buildService({ run: () => new Promise<LivePreSummaryResult>(() => undefined) });
    (service as unknown as { ON_START_SETTLE_MS: number }).ON_START_SETTLE_MS = 30;
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    await tick();

    await service.stop(CID);

    expect(published.some((frame) => frame.closed === true)).toBe(true);
  });
});

describe('TASK-1059 D-08 — a note with no section body is never persisted as a PRE_SUMMARY item', () => {
  it('a failed first flush writes no headings-only LIVE_SOAP_SNAPSHOT row', async () => {
    const contextItems = {
      create: vi.fn(async (entity: unknown) => entity),
      update: vi.fn(async (_id: string, entity: unknown) => entity),
      findAll: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null })),
    };
    const { service } = buildService({
      run: async () => ({ status: 'degraded', reason: 'no_case_notes' }),
      textFails: true,
      contextItems,
    });
    service.start({ consultationId: CID, tenantId: TENANT, userId: 'doctor-1' });
    await tick();
    // Past the durable-snapshot throttle, so the flush WOULD write the row if it had a note to write.
    const session = (service as unknown as { sessions: Map<string, { lastDurableAt: number }> }).sessions.get(CID)!;
    session.lastDurableAt = 0;

    service.ingestSegment(CID, { text: 'patient reports a cough for three days', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: true });

    expect(contextItems.create).not.toHaveBeenCalled();
    expect(contextItems.update).not.toHaveBeenCalled();
  });
});
