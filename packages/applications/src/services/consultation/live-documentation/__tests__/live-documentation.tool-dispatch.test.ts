/**
 * TASK-635 C4 — flush-level tool DISPATCH invariants.
 *
 * The headline invariant (C4-T1): with a null/absent `toolConfig` the flush is
 * behavior-identical to pre-C4 — the same single NLP call, the same entities and
 * vitals in the payload, the same env-gated groundedness, the same trajectory.
 *
 * C4-T2: `ner.enabled:false` ⇒ NO NLP call at all, yet the prior entities are
 * still re-grounded against the current note (grounding is a consumer of tool
 * output, not a tool). `vitals.enabled:false` filters the vitals block off the
 * SAME response — it never costs a second request.
 */

import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { DEFAULT_LIVE_TOOL_PLAN, normalizeToolPlan, type FrozenLiveAgentSnapshot, type ILiveAgentResolver } from '../live-agent.port';

const CID = 'consultation-c4-001';
const TENANT = 'tenant-c4-001';

const NOTE = 'Subjective: patient reports cough and takes aspirin\nObjective:\nAssessment:\nPlan:';

function httpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) {
      return Promise.resolve({
        data: {
          entities: [{ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 0, end: 7 } }],
          vitals: { systolic: 120, diastolic: 80 },
        },
      });
    }
    if (url.includes('/guardrail/ground')) {
      return Promise.resolve({ data: { checked: true, segments: [{ text: NOTE, verdict: 'grounded' }], flagged_spans: [] } });
    }
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE } });
    return Promise.resolve({ data: {} });
  });
  return { post, http: { axiosRef: { post } } };
}

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

function snapshot(toolPlan = DEFAULT_LIVE_TOOL_PLAN): FrozenLiveAgentSnapshot {
  return {
    resolvedFrom: 'agent',
    agentId: 'agent-c4',
    agentName: 'C4 Agent',
    promptTemplateId: 'tmpl-1',
    promptVersionNumber: 1,
    stableUserPrefix: 'PREFIX.',
    systemPrompt: 'SYSTEM.',
    toolPlan,
    liveLlm: null,
    frozenAt: '2026-08-08T00:00:00.000Z',
  };
}

function buildService(opts: { http: unknown; env?: Record<string, unknown>; resolver?: Partial<ILiveAgentResolver> }) {
  const env = { LIVE_DOC_MIN_INTERVAL_MS: '0', ...(opts.env ?? {}) };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  return new LiveDocumentationService(
    opts.http as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined,
    undefined,
    { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.resolver as never,
  );
}

const resolverFor = (plan = DEFAULT_LIVE_TOOL_PLAN): Partial<ILiveAgentResolver> => ({
  resolveForSession: vi.fn().mockResolvedValue(snapshot(plan)),
});

async function flushOnce(service: LiveDocumentationService, text = 'patient reports cough and takes aspirin') {
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text, isFinal: true, segmentId: 's1' });
  return service.flush(CID);
}

const urls = (post: ReturnType<typeof vi.fn>): string[] => post.mock.calls.map((c) => String(c[0]));

describe('C4-T1 — null/absent toolConfig ⇒ behavior byte-identical to pre-C4', () => {
  it('makes exactly one NLP call and publishes the same entities + vitals (no resolver wired)', async () => {
    const { http, post } = httpMock();
    const payload = await flushOnce(buildService({ http }));

    expect(urls(post).filter((u) => u.includes('/classify/tokens'))).toHaveLength(1);
    expect(payload?.entities.map((e) => e.text)).toEqual(['aspirin']);
    expect(payload?.vitals).toEqual({ systolic: 120, diastolic: 80 });
    // groundedness env-default OFF ⇒ no gate call and no block on the payload
    expect(urls(post).some((u) => u.includes('/guardrail/ground'))).toBe(false);
    expect(payload?.groundedness).toBeUndefined();
  });

  it('is identical when the resolver supplies the DEFAULT plan explicitly', async () => {
    const { http, post } = httpMock();
    const payload = await flushOnce(buildService({ http, resolver: resolverFor() }));

    expect(urls(post).filter((u) => u.includes('/classify/tokens'))).toHaveLength(1);
    expect(payload?.entities.map((e) => e.text)).toEqual(['aspirin']);
    expect(payload?.vitals).toEqual({ systolic: 120, diastolic: 80 });
  });

  it('groundedness `enabled:null` follows LIVE_DOC_GROUNDEDNESS_ENABLED (env on ⇒ gate runs)', async () => {
    const { http, post } = httpMock();
    const payload = await flushOnce(buildService({ http, env: { LIVE_DOC_GROUNDEDNESS_ENABLED: 'true' }, resolver: resolverFor() }));

    expect(urls(post).filter((u) => u.includes('/guardrail/ground'))).toHaveLength(1);
    expect(payload?.groundedness?.verdict).toBe('grounded');
  });
});

describe('C4-T2 — a configured plan changes what runs, and only that', () => {
  it('ner+vitals disabled ⇒ NO NLP call, no entities, no vitals', async () => {
    const { http, post } = httpMock();
    const plan = normalizeToolPlan({ version: 1, tools: { ner: { enabled: false }, vitals: { enabled: false } } });
    const payload = await flushOnce(buildService({ http, resolver: resolverFor(plan) }));

    expect(urls(post).some((u) => u.includes('/classify/tokens'))).toBe(false);
    expect(payload?.entities).toEqual([]);
    expect(payload?.vitals).toBeUndefined();
  });

  it('vitals disabled alone ⇒ still ONE NLP call (entities kept), vitals filtered off', async () => {
    const { http, post } = httpMock();
    const plan = normalizeToolPlan({ version: 1, tools: { vitals: { enabled: false } } });
    const payload = await flushOnce(buildService({ http, resolver: resolverFor(plan) }));

    expect(urls(post).filter((u) => u.includes('/classify/tokens'))).toHaveLength(1);
    expect(payload?.entities.map((e) => e.text)).toEqual(['aspirin']);
    expect(payload?.vitals).toBeUndefined();
  });

  it('groundedness forced ON by config runs even when the env default is off', async () => {
    const { http, post } = httpMock();
    const plan = normalizeToolPlan({ version: 1, tools: { groundedness: { enabled: true } } });
    const payload = await flushOnce(buildService({ http, resolver: resolverFor(plan) }));

    expect(urls(post).filter((u) => u.includes('/guardrail/ground'))).toHaveLength(1);
    expect(payload?.groundedness?.verdict).toBe('grounded');
  });

  it('groundedness forced OFF by config does not run even when the env default is on', async () => {
    const { http, post } = httpMock();
    const plan = normalizeToolPlan({ version: 1, tools: { groundedness: { enabled: false } } });
    const payload = await flushOnce(
      buildService({ http, env: { LIVE_DOC_GROUNDEDNESS_ENABLED: 'true' }, resolver: resolverFor(plan) }),
    );

    expect(urls(post).some((u) => u.includes('/guardrail/ground'))).toBe(false);
    expect(payload?.groundedness).toBeUndefined();
  });
});

describe('C4-T4 — anti-laundering: extraction never sees the generated note', () => {
  it('the NLP call body carries the transcript delta only', async () => {
    const { http, post } = httpMock();
    await flushOnce(buildService({ http, resolver: resolverFor() }), 'patient reports cough and takes aspirin');

    const nlpCall = post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'))!;
    const body = nlpCall[1] as { text: string };
    expect(body.text).toBe('patient reports cough and takes aspirin');
    expect(body.text).not.toContain('Subjective:'); // i.e. never the generated note
  });
});
