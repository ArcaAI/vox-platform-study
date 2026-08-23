/**
 * TASK-795 RC-1 — interpreter summary text on the EXISTING live-summary plane.
 *
 * The whole point of reusing `consultation:live-summary:{id}` is that there is no
 * new consumer surface: the SSE route, `useArcaLiveSummary` and the console panel
 * all keep working untouched. That only holds if the published payload is a valid
 * `LiveSummaryEventDto` — which is what this suite pins.
 *
 * It also pins the ONE thing that must be additive: `source`. The plane now has
 * two possible publishers (this service's own flush loop, and an interpreter
 * graph), and a consumer that cannot tell them apart cannot explain what it is
 * showing. `source` is absent on the flush-loop payloads and `'interpreter'` here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import type { LiveSummaryEventDto } from '../dto';

const TENANT = '10000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-rc1';
const CHANNEL = `consultation:live-summary:${CONSULTATION}`;

function buildService() {
  const store = new Map<string, string>();
  const published: { channel: string; payload: LiveSummaryEventDto }[] = [];
  const cacheService = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    publish: vi.fn(async (channel: string, raw: string) => void published.push({ channel, payload: JSON.parse(raw) })),
    del: vi.fn(),
  };
  const service = new LiveDocumentationService(
    { axiosRef: { post: vi.fn() } } as never,
    { get: vi.fn(() => undefined) } as never,
    cacheService as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
  );
  return { service, cacheService, published, store };
}

const body = {
  tenantId: TENANT,
  runningSummary: 'Cough for three days.',
  sections: [{ title: 'Subjective', content: 'Cough for three days.' }],
  source: 'interpreter',
  nodeType: 'consultation.realtimeSummary',
  ordinal: 1,
  total: 3,
  provider: 'lm-studio',
  model: 'a-model',
  taskKey: 'text.live',
  userId: 'u1',
  jobId: 'j1',
};

describe('LiveDocumentationService.publishInterpreterSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes on the EXISTING live-summary channel — no new consumer surface', async () => {
    const { service, published } = buildService();

    const ack = await service.publishInterpreterSummary(CONSULTATION, body);

    expect(ack).toEqual({ ok: true });
    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe(CHANNEL);
  });

  it('emits a valid LiveSummaryEventDto the existing console panel can already render', async () => {
    const { service, published } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, body);

    const payload = published[0].payload;
    expect(payload.consultationId).toBe(CONSULTATION);
    expect(payload.runningSummary).toBe('Cough for three days.');
    expect(payload.sections).toEqual([{ title: 'Subjective', content: 'Cough for three days.' }]);
    // The interpreter plane carries no NER pass of its own; `entities` is a
    // REQUIRED field on the DTO, so it is an empty array, never absent.
    expect(payload.entities).toEqual([]);
  });

  it('stamps updatedAt SERVER-side rather than trusting the caller', async () => {
    const { service, published } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, body);

    expect(Number.isNaN(Date.parse(published[0].payload.updatedAt))).toBe(false);
  });

  it('reports provenance under metadata.stats, where the console already reads it', async () => {
    const { service, published } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, body);

    expect(published[0].payload.metadata?.stats).toMatchObject({ provider: 'lm-studio', model: 'a-model', task_key: 'text.live' });
  });

  it('marks the payload `source: interpreter`, so a consumer can tell the two publishers apart', async () => {
    const { service, published } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, body);

    expect(published[0].payload.source).toBe('interpreter');
    expect(published[0].payload.nodeType).toBe('consultation.realtimeSummary');
    expect(published[0].payload.ordinal).toBe(1);
    expect(published[0].payload.total).toBe(3);
  });

  it('omits absent optionals rather than emitting nulls', async () => {
    const { service, published } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, { tenantId: TENANT, runningSummary: 'x', sections: [], source: 'interpreter' });

    const payload = published[0].payload as Record<string, unknown>;
    expect('nodeType' in payload).toBe(false);
    expect('ordinal' in payload).toBe(false);
    expect('metadata' in payload).toBe(false);
  });

  it('writes the snapshot so a late-joining SSE client sees the last interpreter flush', async () => {
    const { service, store } = buildService();

    await service.publishInterpreterSummary(CONSULTATION, body);

    const snapshot = JSON.parse(store.get(`${CHANNEL}:last`) ?? '{}') as LiveSummaryEventDto;
    expect(snapshot.runningSummary).toBe('Cough for three days.');
  });

  it('acks { ok: false } instead of throwing when Redis is down', async () => {
    const { service, cacheService } = buildService();
    cacheService.publish = vi.fn().mockRejectedValue(new Error('redis down'));

    await expect(service.publishInterpreterSummary(CONSULTATION, body)).resolves.toEqual({ ok: false });
  });
});
