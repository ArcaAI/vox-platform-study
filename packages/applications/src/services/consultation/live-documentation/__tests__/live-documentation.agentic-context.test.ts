/**
 * LiveDocumentationService — `agentic.context.*` live lane.
 *
 * A governed READ facade (`EffectiveSettingsService`) and a
 * governed WRITE route (`PUT /admin/settings/registry/:key`) exist — and the read
 * facade itself notes that live-doc/harness CONSUMPTION of the resolved value
 * was a later addition; the facade only makes the read honest
 * (`effective-settings.service.ts:75-77`).
 *
 * Until this slice, live-doc resolved the six knobs from
 * `env ?? AGENTIC_CONTEXT_DEFAULTS` **in its constructor**. Two consequences:
 *   1. a super admin's registry write changed what `GET /admin/settings/registry`
 *      reported and changed NOTHING about the running loop, and
 *   2. even the env value was frozen at construction, so nothing could move
 *      without a redeploy.
 *
 * The contract pinned here: a change through the registry lane is
 * picked up by the NEXT flush, with no redeploy — and **env now loses to DB**.
 * Env survives only as the fallback when nothing is stored, which keeps an
 * untouched deployment behaving byte-for-byte as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { AGENTIC_CONTEXT_DEFAULTS } from '../../../settings-registry/descriptors/agentic-context.descriptors';

const CID = 'consultation-ctx-1';
const TENANT = 'tenant-ctx';

function buildHttpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
    if (String(url).includes('/generate')) return Promise.resolve({ data: { summary: 'S: ok' } });
    return Promise.resolve({ data: {} });
  });
  return { axiosRef: { post } };
}

/**
 * @param stored values present in the registry (the `global-kv` tier)
 * @param env   `LIVE_DOC_*` / `AGENTIC_CONTEXT_*` env overrides
 */
function buildService(stored: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const cacheService = {
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
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const configService = { get: vi.fn((key: string) => env[key]) };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) };

  // Mirrors the real facade: a stored value reports sourceScope 'global-kv';
  // otherwise the descriptor default under 'code-default'.
  const resolveEffective = vi.fn(async (key: string) => {
    const knob = key.replace('agentic.context.', '') as keyof typeof AGENTIC_CONTEXT_DEFAULTS;
    return key in stored || knob in stored
      ? { key, tier: 'global-kv', value: stored[knob] ?? stored[key], sourceScope: 'global-kv' }
      : { key, tier: 'global-kv', value: AGENTIC_CONTEXT_DEFAULTS[knob], sourceScope: 'code-default' };
  });

  const service = new LiveDocumentationService(
    buildHttpMock() as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    undefined as never,
    undefined as never,
    harnessPolicyService as never,
    undefined as never,
    undefined as never,
    { resolveEffective } as never,
  );
  return { service, resolveEffective };
}

describe('LiveDocumentationService — agentic.context.* live lane', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the STORED registry value, not the code default', async () => {
    const { service } = buildService({ 'liveDelta.maxChars': 999 });

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(999);
  });

  it('DB beats env — a stored value wins over an explicit env override', async () => {
    const { service } = buildService({ 'liveDelta.maxChars': 999 }, { AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS: '4321' });

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(999);
  });

  it('falls back to env when nothing is stored (untouched deployments unchanged)', async () => {
    const { service } = buildService({}, { AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS: '4321', LIVE_DOC_SEGMENT_THRESHOLD: '7' });

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(4321);
    expect(knobs.segmentThreshold).toBe(7);
  });

  it('falls back to the code default when neither is set', async () => {
    const { service } = buildService();

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(AGENTIC_CONTEXT_DEFAULTS['liveDelta.maxChars']);
    expect(knobs.segmentThreshold).toBe(AGENTIC_CONTEXT_DEFAULTS['liveFlush.segmentThreshold']);
    expect(knobs.idleMs).toBe(AGENTIC_CONTEXT_DEFAULTS['liveFlush.idleMs']);
    expect(knobs.transcriptMode).toBe(AGENTIC_CONTEXT_DEFAULTS['transcript.mode']);
    expect(knobs.tokenBudgetPerRun).toBe(AGENTIC_CONTEXT_DEFAULTS['tokenBudget.perRun']);
    expect(knobs.minIntervalMs).toBe(AGENTIC_CONTEXT_DEFAULTS['liveFlush.minIntervalMs']);
  });

  it('TASK-939 R7 — the flush cadence FLOOR is governed, not frozen at construction', async () => {
    // `LIVE_DOC_MIN_INTERVAL_MS` was read once in the constructor, which made the one cadence knob
    // an operator would most want to turn the one that needed a redeploy — the exact freeze this
    // module's header calls out as what made the control plane decorative.
    const stored = await buildService({ 'liveFlush.minIntervalMs': 12_000 }).service.resolveAgenticContext(TENANT);
    expect(stored.minIntervalMs).toBe(12_000);

    // Env remains an override, and LOSES to a stored value, like every other knob here.
    const envOnly = await buildService({}, { LIVE_DOC_MIN_INTERVAL_MS: '250' }).service.resolveAgenticContext(TENANT);
    expect(envOnly.minIntervalMs).toBe(250);

    const bothSet = await buildService({ 'liveFlush.minIntervalMs': 9_000 }, { LIVE_DOC_MIN_INTERVAL_MS: '250' }).service.resolveAgenticContext(TENANT);
    expect(bothSet.minIntervalMs).toBe(9_000);
  });

  it('resolves ALL SIX live knobs through the facade', async () => {
    // claimCheck.minBytes was removed (F-21): the claim-check offload is a
    // Temporal-history concern owned entirely by the harness
    // (HARNESS_CLAIM_CHECK_MIN_BYTES); it never governed anything in the live
    // TEXT loop, so it is no longer resolved here.
    const { service, resolveEffective } = buildService();

    await service.resolveAgenticContext(TENANT);

    const keys = resolveEffective.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual(
      [
        'agentic.context.liveDelta.maxChars',
        'agentic.context.liveFlush.idleMs',
        // TASK-939 R7 — the cadence floor joined the governed set.
        'agentic.context.liveFlush.minIntervalMs',
        'agentic.context.liveFlush.segmentThreshold',
        'agentic.context.tokenBudget.perRun',
        'agentic.context.transcript.mode',
      ].sort(),
    );
  });

  it('is NOT frozen at construction — a registry change lands on the next resolution', async () => {
    const stored: Record<string, unknown> = { 'liveDelta.maxChars': 100 };
    const { service } = buildService(stored);

    expect((await service.resolveAgenticContext(TENANT)).liveDeltaMaxChars).toBe(100);

    // Super admin writes a new value. Same instance, no redeploy.
    stored['liveDelta.maxChars'] = 200;

    expect((await service.resolveAgenticContext(TENANT)).liveDeltaMaxChars).toBe(200);
  });

  it('passes the session tenant into the resolution context', async () => {
    const { service, resolveEffective } = buildService();

    await service.resolveAgenticContext(TENANT);

    expect(resolveEffective.mock.calls[0][1]).toMatchObject({ tenantId: TENANT });
  });

  it('degrades to env/defaults when the facade throws — never blocks a flush', async () => {
    const { service, resolveEffective } = buildService({}, { AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS: '4321' });
    resolveEffective.mockRejectedValue(new Error('settings backend down'));

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(4321);
  });

  it('ignores a stored value of the wrong type rather than producing NaN', async () => {
    const { service } = buildService({ 'liveDelta.maxChars': 'not-a-number' });

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(AGENTIC_CONTEXT_DEFAULTS['liveDelta.maxChars']);
  });

  it('behaves exactly as before when no facade is wired (arity-preserving fixtures)', async () => {
    const cacheService = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      setex: vi.fn(),
      publish: vi.fn(),
      del: vi.fn(),
      eval: vi.fn(),
      sadd: vi.fn(),
      srem: vi.fn(),
      smembers: vi.fn().mockResolvedValue([]),
      expire: vi.fn(),
    };
    const service = new LiveDocumentationService(
      buildHttpMock() as never,
      { get: vi.fn((k: string) => (k === 'AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS' ? '555' : undefined)) } as never,
      cacheService as never,
      { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    );

    const knobs = await service.resolveAgenticContext(TENANT);

    expect(knobs.liveDeltaMaxChars).toBe(555);
  });

  it('the flush actually consumes the resolved delta cap', async () => {
    // End-to-end proof the lane is connected, not just resolvable: a tiny stored
    // cap must truncate the delta the flush sends to TEXT.
    const { service } = buildService({ 'liveDelta.maxChars': 20 });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'a'.repeat(200), isFinal: true, segmentId: 's1' });
    service.ingestSegment(CID, { text: 'b'.repeat(200), isFinal: true, segmentId: 's2' });

    await service.flush(CID, { force: true });

    const http = (service as unknown as { httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } } }).httpService;
    const generate = http.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/generate'));
    // The soft cap admits the first segment whole, then stops — so 'b' never ships.
    expect(String((generate![1] as { prompt: string }).prompt)).not.toContain('b'.repeat(200));
  });
});
