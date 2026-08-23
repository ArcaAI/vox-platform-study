/**
 * TASK-795 RC-2 — `consultation:live-assist:{id}`.
 *
 * A NEW channel, not a reuse, and not the loop plane. Correction proposals quote
 * the clinician's own text verbatim, so this plane is DECLARED PHI-carrying and
 * is a sibling of `live-summary`. The loop event plane is `extra="forbid"` and
 * states it carries "ids/keys/labels only, NEVER note or transcript text" —
 * putting proposals there would be routing PHI down a transport that refuses it.
 *
 * Two behaviours the console depends on:
 *   * a late-joining clinician (refresh, second tab) sees the CURRENT state, so
 *     the plane keeps a snapshot rather than being append-only;
 *   * the two branches are independent — publishing suggestions must not erase
 *     the standing correction proposals, and vice versa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HarnessLiveAssistService } from '../harness-live-assist.service';
import type { HarnessLiveAssistRequest, LiveAssistEventDto } from '../dto';

const TENANT = 'tenant-assist';
const CONSULTATION = 'c-assist';
const CHANNEL = `consultation:live-assist:${CONSULTATION}`;
const SNAPSHOT = `${CHANNEL}:last`;

function buildService() {
  const store = new Map<string, string>();
  const published: { channel: string; payload: LiveAssistEventDto }[] = [];
  const cacheService = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    publish: vi.fn(async (channel: string, raw: string) => void published.push({ channel, payload: JSON.parse(raw) })),
  };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const service = new HarnessLiveAssistService(cacheService as never, redisSubscriber as never);
  return { service, cacheService, published, store };
}

const suggestions: HarnessLiveAssistRequest = {
  tenantId: TENANT,
  kind: 'suggestions',
  nodeType: 'consultation.suggestions',
  suggestions: [{ suggestionId: 'abc123', text: 'Ask about penicillin allergy', category: 'history', status: 'PROPOSED', proposedBy: 'lm-studio:a-model' }],
};

const corrections: HarnessLiveAssistRequest = {
  tenantId: TENANT,
  kind: 'corrections',
  nodeType: 'consultation.proposeCorrections',
  corrections: {
    proposals: [
      { proposalId: 'def456', start: 19, end: 29, original: 'amoxicilin', proposed: 'amoxicillin', category: 'drugName', confidence: 0.96, status: 'PROPOSED' },
    ],
    applied: false,
    appliedCount: 0,
    rejectedProposals: 0,
    textSha256: '0'.repeat(64),
  },
};

describe('HarnessLiveAssistService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes suggestions on the live-assist channel for this consultation', async () => {
    const { service, published } = buildService();

    const ack = await service.publishAssist(CONSULTATION, suggestions);

    expect(ack).toEqual({ ok: true });
    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe(CHANNEL);
    expect(published[0].payload.consultationId).toBe(CONSULTATION);
    expect(published[0].payload.suggestions?.[0]?.suggestionId).toBe('abc123');
  });

  it('never publishes onto the live-summary or loop channels', async () => {
    const { service, published } = buildService();

    await service.publishAssist(CONSULTATION, corrections);

    expect(published.map((p) => p.channel)).not.toContain(`consultation:live-summary:${CONSULTATION}`);
    expect(published.map((p) => p.channel)).not.toContain(`consultation:loop:${CONSULTATION}`);
  });

  it('stores a snapshot so a refreshing clinician does not lose standing proposals', async () => {
    const { service, store } = buildService();

    await service.publishAssist(CONSULTATION, corrections);

    const snapshot = JSON.parse(store.get(SNAPSHOT) ?? '{}') as LiveAssistEventDto;
    expect(snapshot.corrections?.proposals?.[0]?.proposalId).toBe('def456');
  });

  it('keeps the two branches independent — suggestions do not erase corrections', async () => {
    const { service, published } = buildService();

    await service.publishAssist(CONSULTATION, corrections);
    await service.publishAssist(CONSULTATION, suggestions);

    const latest = published[1].payload;
    expect(latest.suggestions?.[0]?.suggestionId).toBe('abc123');
    expect(latest.corrections?.proposals?.[0]?.proposalId).toBe('def456');
  });

  it('a newer corrections publish REPLACES the standing proposals rather than appending', async () => {
    const { service, published } = buildService();

    await service.publishAssist(CONSULTATION, corrections);
    await service.publishAssist(CONSULTATION, {
      ...corrections,
      corrections: { ...corrections.corrections!, proposals: [{ ...corrections.corrections!.proposals[0], proposalId: 'ghi789' }] },
    });

    const latest = published[1].payload;
    expect(latest.corrections?.proposals).toHaveLength(1);
    expect(latest.corrections?.proposals?.[0]?.proposalId).toBe('ghi789');
  });

  it('carries `applied: false` through verbatim — it is a safety assertion, not a default', async () => {
    const { service, published } = buildService();

    await service.publishAssist(CONSULTATION, corrections);

    expect(published[0].payload.corrections?.applied).toBe(false);
  });

  it('stamps updatedAt SERVER-side rather than trusting the caller', async () => {
    const { service, published } = buildService();

    await service.publishAssist(CONSULTATION, suggestions);

    expect(Number.isNaN(Date.parse(published[0].payload.updatedAt))).toBe(false);
  });

  it('acks { ok: false } instead of throwing when Redis is down — a feed hiccup must not fail the run', async () => {
    const { service, cacheService } = buildService();
    cacheService.publish = vi.fn().mockRejectedValue(new Error('redis down'));

    await expect(service.publishAssist(CONSULTATION, suggestions)).resolves.toEqual({ ok: false });
  });

  it('subscribes the SSE relay to this consultation channel', () => {
    const { service } = buildService();

    expect(() => service.subscribeToAssist(CONSULTATION)).not.toThrow();
  });
});
