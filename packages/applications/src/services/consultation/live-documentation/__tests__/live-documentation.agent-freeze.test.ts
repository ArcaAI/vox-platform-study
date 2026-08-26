/**
 * Live-session freeze invariants (rollout table).
 *
 * The governing property of this lane: **an unconfigured tenant sees zero
 * behavior change.** The live loop stops hardcoding its prompt and starts
 * serving a frozen, governed agent snapshot — but with no agent binding the
 * resolved bytes are the SYSTEM default, which is byte-identical to the in-code
 * constants, so the TEXT payload is unchanged down to the byte.
 *
 *   C3-T1  default-prompt parity (prompt + system_prompt byte-identical)
 *   C3-T2  freeze semantics + Redis adopt (cross-instance / crash recovery)
 *   C3-T3  SSE DTO additive-only
 *   C3-T4  fail-open (resolver throws ⇒ session still starts and flushes)
 *   C3-T5  zero added blocking I/O per flush
 */

import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService, LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LIVE_DOCUMENT_SYSTEM_PROMPT } from '../live-documentation.service';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot, type ILiveAgentResolver } from '../live-agent.port';

const CID = 'consultation-agent-001';
const TENANT = 'tenant-agent-001';

interface TextCall {
  prompt: string;
  system_prompt: string;
  provider?: string;
  model?: string;
}

function recordingHttpMock(calls: TextCall[]) {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: Record<string, unknown>) => {
        if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
        if (url.includes('/generate')) {
          calls.push(body as unknown as TextCall);
          return Promise.resolve({ data: { summary: 'Subjective: cough\nObjective:\nAssessment:\nPlan:' } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

function cacheMock(overrides: Partial<Record<string, unknown>> = {}) {
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
    ...overrides,
  };
}

/** A snapshot as the port would return it for a tenant with an agent binding. */
function agentSnapshot(overrides: Partial<FrozenLiveAgentSnapshot> = {}): FrozenLiveAgentSnapshot {
  return {
    resolvedFrom: 'agent',
    agentId: 'agent-1',
    agentName: 'Surgery Default Agent',
    promptTemplateId: 'tmpl-live-1',
    promptVersionNumber: 4,
    stableUserPrefix: 'CUSTOM SURGERY LIVE PREFIX.',
    systemPrompt: 'CUSTOM SURGERY SYSTEM PROMPT.',
    toolPlan: DEFAULT_LIVE_TOOL_PLAN,
    liveLlm: null,
    frozenAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

function buildService(opts: {
  http: unknown;
  cache?: ReturnType<typeof cacheMock>;
  resolver?: Partial<ILiveAgentResolver>;
  harnessPolicyService?: unknown;
  contextItemRepository?: unknown;
}) {
  const configService = { get: vi.fn().mockImplementation((k: string) => (({ LIVE_DOC_MIN_INTERVAL_MS: '0' }) as Record<string, unknown>)[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  return new LiveDocumentationService(
    opts.http as never,
    configService as never,
    (opts.cache ?? cacheMock()) as never,
    redisSubscriber as never,
    undefined,
    opts.contextItemRepository as never,
    (opts.harnessPolicyService ?? { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) }) as never,
    // A SecretsService stand-in: `.env.test` runs SECRETS_PROVIDER=vault, under
    // which `encryptPhiFields` FAILS CLOSED rather than persisting plaintext PHI.
    // Without one the durable-snapshot write is (correctly) refused.
    //
    // `getSecretOptional` is REQUIRED, not decorative: `callText` resolves
    // `TEXT_SERVICE_TOKEN` through it for the authenticated gateway→TEXT hop
    // A stand-in missing the method throws inside the flush's try,
    // which the catch turns into "TEXT failed" — so every assertion about the
    // TEXT payload silently sees zero calls instead of failing loudly.
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.resolver as never,
  );
}

/** Deterministically wait for the fire-and-forget start-time resolution. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('The gateway→TEXT hop is authenticated', () => {
  it('sends X-Service-Token resolved from TEXT_SERVICE_TOKEN', async () => {
    const calls: TextCall[] = [];
    const http = recordingHttpMock(calls);
    const service = buildService({ http });
    // Re-point the stand-in at a configured secret (the default resolves '').
    (service as unknown as { secretsService: { getSecretOptional: ReturnType<typeof vi.fn> } }).secretsService.getSecretOptional = vi
      .fn()
      .mockResolvedValue('text-token');

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    const generate = http.axiosRef.post.mock.calls.find(([url]: [string]) => String(url).includes('/generate'));
    expect(generate, 'the live loop must reach TEXT').toBeTruthy();
    // Without this header TEXT answers `invalid_or_missing_token` in every
    // environment where the token is set, and the flush degrades to an empty
    // note — silently, because the failure never reaches the SSE payload.
    expect(generate![2].headers['X-Service-Token']).toBe('text-token');
  });
});

describe('C3-T1 — default-prompt parity (the unconfigured tenant sees zero change)', () => {
  it('with NO resolver port wired, the TEXT payload is byte-identical to the pre-C3 constants', async () => {
    const calls: TextCall[] = [];
    const service = buildService({ http: recordingHttpMock(calls) });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt.startsWith(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX)).toBe(true);
    expect(calls[0].system_prompt).toBe(LIVE_DOCUMENT_SYSTEM_PROMPT);
  });

  it('with the port resolving the SYSTEM default (bytes == the constants), the payload is still byte-identical', async () => {
    const calls: TextCall[] = [];
    const resolver: Partial<ILiveAgentResolver> = {
      resolveForSession: vi.fn().mockResolvedValue(
        agentSnapshot({
          resolvedFrom: 'default',
          agentId: null,
          agentName: null,
          promptTemplateId: '71000000-0000-0000-0004-000000000001',
          promptVersionNumber: 1,
          stableUserPrefix: LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX,
          systemPrompt: LIVE_DOCUMENT_SYSTEM_PROMPT,
        }),
      ),
    };
    const service = buildService({ http: recordingHttpMock(calls), resolver });
    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls[0].prompt.startsWith(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX)).toBe(true);
    expect(calls[0].system_prompt).toBe(LIVE_DOCUMENT_SYSTEM_PROMPT);
  });

  it('a bound agent’s prompt bytes actually reach TEXT (the capability is real, not decorative)', async () => {
    const calls: TextCall[] = [];
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot()) };
    const service = buildService({ http: recordingHttpMock(calls), resolver });
    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls[0].prompt.startsWith('CUSTOM SURGERY LIVE PREFIX.')).toBe(true);
    expect(calls[0].system_prompt).toBe('CUSTOM SURGERY SYSTEM PROMPT.');
  });

  it('an agent llmOverrides.live selection is served FROZEN, bypassing the per-flush tenant resolve (RF-4)', async () => {
    const calls: TextCall[] = [];
    const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) };
    const resolver: Partial<ILiveAgentResolver> = {
      resolveForSession: vi.fn().mockResolvedValue(agentSnapshot({ liveLlm: { provider: 'llama-cpp', model: 'fast-live-model' } })),
    };
    const service = buildService({ http: recordingHttpMock(calls), resolver, harnessPolicyService });
    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls[0].provider).toBe('llama-cpp');
    expect(calls[0].model).toBe('fast-live-model');
    expect(harnessPolicyService.resolveTextSelection).not.toHaveBeenCalled();
  });

  it('with NO agent override the per-flush tenant AiTaskDefault resolve is preserved exactly', async () => {
    const calls: TextCall[] = [];
    const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) };
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot({ liveLlm: null })) };
    const service = buildService({ http: recordingHttpMock(calls), resolver, harnessPolicyService });
    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'fever', isFinal: true, segmentId: 's2' });
    await service.flush(CID);

    expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledTimes(2);
    expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledWith(TENANT, 'live');
    expect(calls[1].model).toBe('tenant-default');
  });
});

describe('C3-T2 — freeze semantics and three-tier recovery', () => {
  it('resolves ONCE per session: a mid-session re-point cannot change the running prompt', async () => {
    const calls: TextCall[] = [];
    const resolveForSession = vi
      .fn()
      .mockResolvedValueOnce(agentSnapshot({ stableUserPrefix: 'V1 PREFIX.' }))
      // If the loop ever re-resolved, this newer binding would leak in.
      .mockResolvedValue(agentSnapshot({ stableUserPrefix: 'V2 PREFIX (MUST NEVER APPEAR).' }));
    const service = buildService({ http: recordingHttpMock(calls), resolver: { resolveForSession } });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    for (const [i, text] of ['cough', 'fever', 'rash'].entries()) {
      service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${i}` });
      await service.flush(CID);
    }

    expect(resolveForSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.prompt.startsWith('V1 PREFIX.')).toBe(true);
  });

  it('persists the frozen snapshot to Redis under the agent key with the owner-lock TTL', async () => {
    const cache = cacheMock();
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot()) };
    const service = buildService({ http: recordingHttpMock([]), cache, resolver });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();

    const write = cache.setex.mock.calls.find(([key]) => String(key).endsWith(':agent'));
    expect(write, 'the frozen snapshot must be mirrored to Redis for cross-instance recovery').toBeTruthy();
    expect(write![0]).toBe(`consultation:live-summary:${CID}:agent`);
    expect(write![1]).toBe(3600); // = LOCK_TTL, refreshed alongside the fenced lock renewal
    expect(JSON.parse(String(write![2])).promptVersionNumber).toBe(4);
  });

  it('ADOPTS a stored snapshot verbatim (second instance / restart) instead of re-resolving', async () => {
    const stored = agentSnapshot({ stableUserPrefix: 'ADOPTED PREFIX.', promptVersionNumber: 9 });
    const cache = cacheMock({
      get: vi.fn().mockImplementation(async (key: string) => (key.endsWith(':agent') ? JSON.stringify(stored) : null)),
    });
    const calls: TextCall[] = [];
    const resolveForSession = vi.fn().mockResolvedValue(agentSnapshot({ stableUserPrefix: 'FRESH PREFIX (MUST NEVER APPEAR).' }));
    const service = buildService({ http: recordingHttpMock(calls), cache, resolver: { resolveForSession } });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(resolveForSession).not.toHaveBeenCalled();
    expect(calls[0].prompt.startsWith('ADOPTED PREFIX.')).toBe(true);
  });

  it('stamps the agent lineage into the durable LIVE_SOAP_SNAPSHOT metaData (the C5 hand-off)', async () => {
    const created: { metaData?: Record<string, unknown> }[] = [];
    const contextItemRepository = {
      findPreSummaries: vi.fn().mockResolvedValue([]),
      // `findLiveSnapshotRow` now delegates to this repository
      // helper; mirror it through the SAME `findPreSummaries` mock above so
      // the create-vs-reuse dedup this test drives is unaffected.
      findLatestPreSummaryWithDecryptedContent: vi.fn(async (consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
        const rows: Array<{ metaData?: unknown; createdAt: Date; content?: string | null }> =
          await contextItemRepository.findPreSummaries(consultationId);
        const candidates = options?.subType
          ? rows.filter((r) => (r.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
          : rows;
        if (candidates.length === 0) return { entity: null, plaintext: null };
        const entity = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
        return { entity, plaintext: entity.content ?? null };
      }),
      create: vi.fn().mockImplementation(async (entity: { metaData?: Record<string, unknown> }) => {
        created.push(entity);
      }),
      update: vi.fn().mockResolvedValue(undefined),
      encryptContentIntoEntity: vi.fn(),
    };
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot()) };
    const service = buildService({ http: recordingHttpMock([]), resolver, contextItemRepository });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: true });

    expect(created.length).toBeGreaterThan(0);
    const meta = created[0].metaData as { subType?: string; agent?: Record<string, unknown> };
    expect(meta.subType).toBe('LIVE_SOAP_SNAPSHOT'); // unchanged — C5 EXTENDS this row, never restructures it
    expect(meta.agent).toMatchObject({
      agentId: 'agent-1',
      promptTemplateId: 'tmpl-live-1',
      promptVersionNumber: 4,
      resolvedFrom: 'agent',
    });
    // Prompt BYTES are never duplicated into the durable row — only the pin.
    expect(JSON.stringify(meta.agent)).not.toContain('CUSTOM SURGERY LIVE PREFIX.');
  });
});

describe('C3-T3 — SSE DTO additive-only', () => {
  it('adds ONLY metadata.agent to the published payload when a governed tier resolved', async () => {
    const cache = cacheMock();
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot()) };
    const service = buildService({ http: recordingHttpMock([]), cache, resolver });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    expect(payload!.metadata!.agent).toEqual({
      id: 'agent-1',
      name: 'Surgery Default Agent',
      promptTemplateId: 'tmpl-live-1',
      promptVersionNumber: 4,
      resolvedFrom: 'agent',
    });
    // Every pre-C3 field is untouched.
    expect(Object.keys(payload!).sort()).toEqual([
      'consultationId',
      'entities',
      'lastSegmentId',
      'metadata',
      'runningSummary',
      'sections',
      'updatedAt',
    ]);
  });

  it('publishes the pre-C3 shape verbatim on the code-default tier (no metadata block invented)', async () => {
    const service = buildService({ http: recordingHttpMock([]) }); // no port ⇒ code-default
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    expect(payload!.metadata).toBeUndefined();
  });
});

describe('C3-T4 — fail-open: a resolution failure never fails a live consultation', () => {
  it('a throwing resolver still starts the session and flushes with the in-code constants', async () => {
    const calls: TextCall[] = [];
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockRejectedValue(new Error('resolver exploded')) };
    const service = buildService({ http: recordingHttpMock(calls), resolver });

    expect(() => service.start({ consultationId: CID, tenantId: TENANT })).not.toThrow();
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    expect(payload).not.toBeNull();
    expect(calls[0].prompt.startsWith(LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX)).toBe(true);
    expect(calls[0].system_prompt).toBe(LIVE_DOCUMENT_SYSTEM_PROMPT);
  });

  it('a Redis outage on the agent key degrades to a fresh resolve rather than failing', async () => {
    const cache = cacheMock({ get: vi.fn().mockRejectedValue(new Error('redis down')), setex: vi.fn().mockRejectedValue(new Error('redis down')) });
    const calls: TextCall[] = [];
    const resolver: Partial<ILiveAgentResolver> = { resolveForSession: vi.fn().mockResolvedValue(agentSnapshot()) };
    const service = buildService({ http: recordingHttpMock(calls), cache, resolver });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    expect(calls[0].prompt.startsWith('CUSTOM SURGERY LIVE PREFIX.')).toBe(true);
  });
});

describe('C3-T5 — zero added blocking I/O per flush', () => {
  it('neither the resolver nor the agent Redis key is touched during ANY flush', async () => {
    const cache = cacheMock();
    const resolveForSession = vi.fn().mockResolvedValue(agentSnapshot());
    const service = buildService({ http: recordingHttpMock([]), cache, resolver: { resolveForSession } });

    service.start({ consultationId: CID, tenantId: TENANT });
    await settle();

    const resolverCallsAtStart = resolveForSession.mock.calls.length;
    const agentKeyReadsAtStart = cache.get.mock.calls.filter(([k]) => String(k).endsWith(':agent')).length;
    const agentKeyWritesAtStart = cache.setex.mock.calls.filter(([k]) => String(k).endsWith(':agent')).length;

    for (const [i, text] of ['cough', 'fever', 'rash', 'nausea'].entries()) {
      service.ingestSegment(CID, { text, isFinal: true, segmentId: `s${i}` });
      await service.flush(CID);
    }

    expect(resolveForSession.mock.calls.length).toBe(resolverCallsAtStart);
    expect(cache.get.mock.calls.filter(([k]) => String(k).endsWith(':agent')).length).toBe(agentKeyReadsAtStart);
    expect(cache.setex.mock.calls.filter(([k]) => String(k).endsWith(':agent')).length).toBe(agentKeyWritesAtStart);
  });

  it('a flush that starts before resolution completes still serves the frozen snapshot (await, never re-resolve)', async () => {
    const calls: TextCall[] = [];
    let release!: (snapshot: FrozenLiveAgentSnapshot) => void;
    const pending = new Promise<FrozenLiveAgentSnapshot>((resolve) => {
      release = resolve;
    });
    const resolveForSession = vi.fn().mockReturnValue(pending);
    const service = buildService({ http: recordingHttpMock(calls), resolver: { resolveForSession } });

    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'cough', isFinal: true, segmentId: 's1' });
    const flushed = service.flush(CID);
    release(agentSnapshot({ stableUserPrefix: 'SLOW-RESOLVED PREFIX.' }));
    await flushed;

    expect(resolveForSession).toHaveBeenCalledTimes(1);
    expect(calls[0].prompt.startsWith('SLOW-RESOLVED PREFIX.')).toBe(true);
  });
});
