/**
 * TASK-946 D6(b) — a FAILED flush is counted as failed, and the reason is a code.
 *
 * ## The defect
 *
 * The per-flush stats line carried `turnDegraded` — which means "the turn contract fell back to a
 * whole-document rewrite", a QUALITY signal about a flush that succeeded — and `textFailed`, and
 * nothing that said "this flush produced no note". So the 2026-09-10 trial's three consultations
 * looked, in the stats, like sessions with a lot of `turnDegraded: false` flushes.
 *
 * And the reason that DID travel was a transport string: the `section.patch` envelope carried
 * `degradeReason: "degraded: Request failed with status code 502"`, which names the HTTP client
 * rather than the failure and is the one field on that surface that could carry clinical text out
 * of a model's refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveDocSessionStatsResponse } from '../dto/live-doc-admin.dto';
import type { LiveSummaryEventDto } from '../dto/live-summary.dto';
import type { SectionPatchDto } from '../realtime';

const CID = 'consultation-946-flush';
const TENANT = 'tenant-946-flush';

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

/** `textFails` reproduces the 2026-09-10 trial: TEXT answers 502 on every generation. */
function buildService(cache: ReturnType<typeof cacheMock>, textFails: boolean) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      if (textFails) throw new Error('Request failed with status code 502');
      return { data: { summary: JSON.stringify({ subjective: { mode: 'append', content: 'cough x3d' } }) } };
    }
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };

  return new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null, departmentId: null, parentConsultationId: null })) } as never,
  );
}

async function runFlush(textFails: boolean) {
  const cache = cacheMock();
  const service = buildService(cache, textFails);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'patient reports a cough for three days', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return cache;
}

const sectionPatches = (cache: ReturnType<typeof cacheMock>): SectionPatchDto[] =>
  cache.published.filter((p): p is SectionPatchDto => (p as SectionPatchDto).event === 'section.patch');

const summaryEvents = (cache: ReturnType<typeof cacheMock>): LiveSummaryEventDto[] =>
  cache.published.filter((p): p is LiveSummaryEventDto => (p as { event?: string }).event === undefined && 'runningSummary' in (p as object));

describe('TASK-946 D6 — a failed flush is counted as failed', () => {
  it('the admin stats snapshot carries flushFailed and the reason CODE', async () => {
    const cache = await runFlush(true);
    const stats = cache.stats.at(-1);

    expect(stats, 'no stats snapshot was published for the failing flush').toBeDefined();
    expect(stats!.flushFailed, 'the flush produced no note and nothing counted it as failed').toBe(true);
    expect(stats!.degradeReason).toBe('text_unavailable');
    // The two existing flags are UNCHANGED and still mean what they meant.
    expect(stats!.textFailed).toBe(true);
    expect(stats!.turnDegraded).toBe(false);
  });

  it('the section.patch reason is a CODE, not `degraded: Request failed with status code 502`', async () => {
    const patches = sectionPatches(await runFlush(true));

    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(patch.degradeReason).toBe('text_unavailable');
      expect(patch.degradeReason).not.toMatch(/status code|degraded:/);
    }
  });

  it('the whole-document payload the SSE consumer receives says the flush failed, and why', async () => {
    const events = summaryEvents(await runFlush(true));
    const last = events.at(-1);

    expect(last, 'no live-summary payload was published').toBeDefined();
    expect(last!.flushFailed).toBe(true);
    expect(last!.degradeReason).toBe('text_unavailable');
  });

  it('a HEALTHY flush reports flushFailed false and no reason at all', async () => {
    const cache = await runFlush(false);
    const stats = cache.stats.at(-1);

    expect(stats!.flushFailed).toBe(false);
    expect(stats!.degradeReason).toBeUndefined();

    const last = summaryEvents(cache).at(-1);
    expect(last!.flushFailed).toBeUndefined();
    expect(last!.degradeReason).toBeUndefined();
  });
});
