/**
 * TASK-891 B4/B5 — a failed realtime flush must be VISIBLE, on both surfaces.
 *
 * ## What the traced session looked like from outside
 *
 * ```
 * 08:16:09 WARN Realtime lane node degraded  n_realtime  consultation.realtimeSummary
 *               reason: "timeout of 20000ms exceeded"
 * 08:16:09 WARN Realtime lane node degraded  n_entities  consultation.extractEntities
 *               reason: "connect ECONNREFUSED 10.43.207.213:8864"
 * 08:16:09 Live summary flush  flushCount 1  sectionCount 0  staleDropCount 38
 * ```
 *
 * Both reasons existed ONLY in those gateway WARN lines:
 *
 *  - **B4** — the admin stats snapshot reported `textFailed`/`nlpFailed` but never WHICH node
 *    or WHY, so diagnosing a live session required pod access.
 *  - **B5** — `publishSectionPatches` returned early on an empty section list, so the console
 *    received nothing at all. `case-note-column.tsx:120` renders `state: 'empty'` as a
 *    `<Skeleton />`, which is correct for a section still being written and indistinguishable
 *    from one the engine could not write. The owner watched that skeleton for ten minutes.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveDocSessionStatsResponse } from '../dto/live-doc-admin.dto';
import type { SectionPatchDto } from '../realtime';

const CID = 'consultation-degrade-001';
const TENANT = 'tenant-degrade-001';
const TEXT_ERROR = 'timeout of 60000ms exceeded';

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

function cacheMock() {
  const stats: LiveDocSessionStatsResponse[] = [];
  const published: unknown[] = [];
  return {
    stats,
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      if (key.startsWith('live-doc:stats:')) stats.push(JSON.parse(raw) as LiveDocSessionStatsResponse);
    }),
    publish: vi.fn(async (_channel: string, raw: string) => {
      published.push(JSON.parse(raw));
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/** A stack where TEXT times out — the measured production failure. */
function buildService(cache: ReturnType<typeof cacheMock>) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) throw new Error(TEXT_ERROR);
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  return new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    effectiveSettings as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
  );
}

async function runFailingFlush() {
  const cache = cacheMock();
  const service = buildService(cache);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return cache;
}

const sectionPatches = (cache: ReturnType<typeof cacheMock>): SectionPatchDto[] =>
  cache.published.filter((p): p is SectionPatchDto => (p as SectionPatchDto).event === 'section.patch');

describe('TASK-891 B4 — the admin stats snapshot names the node that degraded', () => {
  it('carries the per-node degrade reasons beside textFailed/nlpFailed', async () => {
    const cache = await runFailingFlush();

    const stats = cache.stats.at(-1);
    expect(stats, 'no stats snapshot was published for the failing flush').toBeDefined();
    expect(stats!.textFailed).toBe(true);
    expect(stats!.staleDropCount).toBe(0);

    const degrades = stats!.nodeDegrades ?? [];
    const summary = degrades.find((d) => d.type === 'consultation.realtimeSummary');
    expect(summary, 'the failing node is not named on the admin surface — diagnosing it still needs pod logs').toBeDefined();
    expect(summary!.reason).toContain(TEXT_ERROR);
    expect(summary!.nodeId).toBeTruthy();
  });
});

describe('TASK-891 B5 — a failed generation reaches the console as an honest state', () => {
  it('publishes a section.patch carrying a degrade reason instead of publishing nothing', async () => {
    const cache = await runFailingFlush();
    const patches = sectionPatches(cache);

    expect(patches.length, 'the flush failed and published no section.patch at all — the console renders a skeleton forever').toBeGreaterThan(0);
    for (const patch of patches) {
      expect(patch.state).toBe('empty');
      expect(patch.degradeReason).toContain(TEXT_ERROR);
      // A degrade patch persists nothing, so it must never claim a revision that could
      // displace real content in a client that follows the DTO's discard rule.
      expect(patch.revision).toBe(0);
      expect(patch.content).toBe('');
    }
  });

  it('the four existing section states are untouched — a degrade is a reason, not a fifth state', async () => {
    const cache = await runFailingFlush();
    for (const patch of sectionPatches(cache)) {
      expect(['empty', 'provisional', 'confirmed', 'locked']).toContain(patch.state);
    }
  });
});
