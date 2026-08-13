/**
 * Live OUTPUT groundedness gate wiring tests.
 *
 * The flush must verify the generated running note against the source transcript
 * (guardrail `POST /api/guardrail/ground`) BETWEEN building `runningSummary` and
 * `safePublish`, so ungrounded segments carry their mark before the clinician
 * reads them. Fail posture (pairs with the input gate, adapted to a
 * best-effort streaming surface):
 *   - gate disabled (default)      → payload unchanged, guardrail never called
 *   - transient blip               → absorbed by a bounded retry (verified after a clean re-check)
 *   - sustained outage / malformed → segments marked `unverified`, feed STILL publishes
 *   - NO error path may ever yield `grounded`
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-479';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:live-summary:${CID}`;

const TWO_SEGMENT_SUMMARY = 'Pt on amlodipine for HTN. MRI confirmed metastasis.';

/** Guardrail `/guardrail/ground` wire response (snake_case, mirrors the FastAPI contract). */
const GROUND_WIRE_MIXED = {
  segments: [
    { text: 'Pt on amlodipine for HTN.', verdict: 'grounded', grounded: true, score: 0.9, start: 0, end: 25 },
    { text: 'MRI confirmed metastasis.', verdict: 'ungrounded', grounded: false, score: 0.1, start: 26, end: 51 },
  ],
  flagged_spans: [{ start: 26, end: 51 }],
  checked: true,
  reason: 'checked',
  model_id: 'stub-nli',
  throughput_docs_per_min: 1200,
  processing_time_ms: 4,
  request_id: 'r1',
  timestamp: 'now',
};

const GROUND_WIRE_ALL_GROUNDED = {
  ...GROUND_WIRE_MIXED,
  segments: GROUND_WIRE_MIXED.segments.map((s) => ({ ...s, verdict: 'grounded', grounded: true, score: 0.9 })),
  flagged_spans: [],
};

interface HttpMockOptions {
  /** Handler for the `/guardrail/ground` call; default resolves the mixed fixture. */
  ground?: (body: unknown) => Promise<{ data: unknown }>;
  /** Summary the SMR `/generate` mock returns. */
  summary?: string;
  /** Entities the NLP `/classify/tokens` mock returns (default: a single MEDICATION). */
  classifyEntities?: unknown[];
  /** Vitals (snake_case wire shape) the NLP `/classify/tokens` mock returns. */
  classifyVitals?: unknown;
}

function buildHttpMock(opts: HttpMockOptions = {}) {
  const ground = opts.ground ?? (() => Promise.resolve({ data: GROUND_WIRE_MIXED }));
  const summary = opts.summary ?? TWO_SEGMENT_SUMMARY;
  const classifyEntities = opts.classifyEntities ?? [
    { entity_type: 'MEDICATION', text: 'amlodipine', confidence: 0.92, position: { start: 6, end: 16 } },
  ];
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string, body: unknown) => {
        if (url.includes('/guardrail/ground')) return ground(body);
        if (url.includes('/classify/tokens')) {
          return Promise.resolve({ data: { entities: classifyEntities, ...(opts.classifyVitals ? { vitals: opts.classifyVitals } : {}) } });
        }
        if (url.includes('/generate')) return Promise.resolve({ data: { summary } });
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

interface BuildDepsOpts {
  config?: Record<string, unknown>;
  secretsService?: any;
}

function buildDeps(httpMock = buildHttpMock(), opts: BuildDepsOpts = {}) {
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
  const audioBridge = {
    subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }),
    unsubscribeFromResults: vi.fn(),
  };
  const contextItemRepository = {
    create: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    update: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    // `findLiveSnapshotRow` now delegates to this repository helper;
    // mirror it through the SAME `findPreSummaries` mock above.
    findLatestPreSummaryWithDecryptedContent: vi.fn(async (consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
      const rows: Array<{ metaData?: unknown; createdAt: Date; content?: string | null }> = await contextItemRepository.findPreSummaries(
        consultationId,
      );
      const candidates = options?.subType
        ? rows.filter((r) => (r.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
        : rows;
      if (candidates.length === 0) return { entity: null, plaintext: null };
      const entity = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      return { entity, plaintext: entity.content ?? null };
    }),
  };
  const config = opts.config ?? {};
  const configService = { get: vi.fn().mockImplementation((key: string) => config[key]) };
  const harnessPolicyService = {
    resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'live-medgemma' }),
  };
  const secretsService = opts.secretsService;

  const service = new LiveDocumentationService(
    httpMock as any,
    configService as any,
    cacheService as any,
    redisSubscriber as any,
    audioBridge as any,
    contextItemRepository as any,
    harnessPolicyService as any,
    secretsService as any,
  );

  return { service, cacheService, httpMock };
}

const ENABLED_CONFIG = {
  LIVE_DOC_GROUNDEDNESS_ENABLED: 'true',
  LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS: '0',
  LIVE_DOC_MIN_INTERVAL_MS: '0',
};

const groundCalls = (httpMock: ReturnType<typeof buildHttpMock>) =>
  httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/guardrail/ground'));

describe('LiveDocumentationService — output groundedness gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Baseline: the un-gated flush publishes NO verdict — the gate is
  // strictly opt-in (dev/CI bypass, mirroring the input gate's `enabled` posture).
  // ------------------------------------------------------------------
  it('publishes the payload with no groundedness verdict when the gate is disabled (default)', async () => {
    const httpMock = buildHttpMock();
    const { service, cacheService } = buildDeps(httpMock, { config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.groundedness).toBeUndefined();
    expect(groundCalls(httpMock)).toHaveLength(0);
    const published = JSON.parse(cacheService.publish.mock.calls[0][1]);
    expect(published).not.toHaveProperty('groundedness');
  });

  // ------------------------------------------------------------------
  // Gated: ungrounded segments carry the flag BEFORE publish.
  // ------------------------------------------------------------------
  it('marks ungrounded segments in the published payload when the gate is enabled', async () => {
    const httpMock = buildHttpMock();
    const { service, cacheService } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.groundedness).toBeDefined();
    expect(payload!.groundedness!.verdict).toBe('ungrounded'); // worst-state rollup of mixed verdicts
    expect(payload!.groundedness!.segments).toEqual([
      { text: 'Pt on amlodipine for HTN.', verdict: 'grounded', score: 0.9, start: 0, end: 25 },
      { text: 'MRI confirmed metastasis.', verdict: 'ungrounded', score: 0.1, start: 26, end: 51 },
    ]);
    expect(payload!.groundedness!.flaggedSpans).toEqual([{ start: 26, end: 51 }]);

    // The verdict is attached BEFORE publish: the published SSE payload carries it.
    const published = JSON.parse(cacheService.publish.mock.calls[0][1]);
    expect(published.groundedness.verdict).toBe('ungrounded');
    expect(published.groundedness.segments).toHaveLength(2);

    // The gate ran AFTER the note was generated (verifies the generated text, not the prompt).
    const postUrls = httpMock.axiosRef.post.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(postUrls.findIndex((u) => u.includes('/generate'))).toBeLessThan(postUrls.findIndex((u) => u.includes('/guardrail/ground')));
  });

  it('sends {summary, transcript} to the configured GUARDRAIL_URL with the service token', async () => {
    const httpMock = buildHttpMock();
    const secretsService = { getSecretOptional: vi.fn().mockResolvedValue('guard-tok') };
    const { service } = buildDeps(httpMock, {
      config: { ...ENABLED_CONFIG, GUARDRAIL_URL: 'http://guardrail.test:9999' },
      secretsService,
    });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    await service.flush(CID);

    const [url, body, config] = groundCalls(httpMock)[0] as [string, { summary: string; transcript: string }, { headers: Record<string, string> }];
    expect(url).toBe('http://guardrail.test:9999/api/guardrail/ground');
    expect(body.summary).toBe(TWO_SEGMENT_SUMMARY); // the generated note, not the prompt
    expect(body.transcript).toBe('Patient on amlodipine'); // the source transcript
    expect(config.headers['X-Service-Token']).toBe('guard-tok');
    expect(secretsService.getSecretOptional).toHaveBeenCalledWith('GUARDRAIL_SERVICE_TOKEN');
  });

  it('keeps runningSummary, sections, and entities unchanged when the gate is enabled', async () => {
    const httpMock = buildHttpMock();
    const { service } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.runningSummary).toBe(TWO_SEGMENT_SUMMARY);
    expect(payload!.sections).toEqual([{ title: 'Running Summary', content: TWO_SEGMENT_SUMMARY }]);
    expect(payload!.entities).toEqual([{ text: 'amlodipine', type: 'MEDICATION', confidence: 0.92, start: 6, end: 16 }]);
  });

  it('carries the NLP ontology ICD-10 code through to the published entity', async () => {
    const httpMock = buildHttpMock({
      summary: 'Assessment: essential hypertension, stable on therapy.',
      classifyEntities: [
        { entity_type: 'DISEASE_DISORDER', text: 'hypertension', confidence: 0.9, icd_code: 'I10', position: { start: 0, end: 12 } },
      ],
    });
    const { service } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient with hypertension', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.entities).toHaveLength(1);
    expect(payload!.entities[0]).toMatchObject({ text: 'hypertension', type: 'DISEASE_DISORDER', icd10: 'I10' });
  });

  it('maps the NLP vitals (snake_case) onto the published payload', async () => {
    const httpMock = buildHttpMock({
      classifyVitals: { systolic: 138, diastolic: 88, heart_rate: 78, spo2: 98, temperature_c: 36.8, weight_kg: 71 },
    });
    const { service } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.vitals).toEqual({ systolic: 138, diastolic: 88, heartRate: 78, spo2: 98, temperatureC: 36.8, weightKg: 71 });
  });

  it('omits vitals when the NLP service reports none', async () => {
    const httpMock = buildHttpMock();
    const { service } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.vitals).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Degrade-safe → fail-CLOSED. A blip is absorbed; a sustained outage
  // marks `unverified` and the feed keeps publishing; NO error path yields
  // `grounded`.
  // ------------------------------------------------------------------
  it('absorbs a transient blip with a bounded retry (verdict from the clean re-check)', async () => {
    let attempts = 0;
    const httpMock = buildHttpMock({
      ground: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('guardrail blip'));
        return Promise.resolve({ data: GROUND_WIRE_ALL_GROUNDED });
      },
    });
    const { service } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(attempts).toBe(2); // one blip + one clean re-check, nothing more
    expect(payload!.groundedness!.verdict).toBe('grounded'); // verified after the clean re-check
  });

  it('degrades to unverified on a sustained outage, keeps publishing, and never marks grounded', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const httpMock = buildHttpMock({ ground: () => Promise.reject(new Error('guardrail down')) });
    const { service, cacheService } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    // Bounded: default max retries = 1 → exactly 2 attempts, then degrade.
    expect(groundCalls(httpMock)).toHaveLength(2);

    // Fail-closed: the error branch yields `unverified` — never `grounded`.
    expect(payload!.groundedness!.verdict).toBe('unverified');
    expect(payload!.groundedness!.segments ?? []).not.toContainEqual(expect.objectContaining({ verdict: 'grounded' }));

    // The live feed is NOT frozen or dropped: the payload still publishes, marked.
    const published = JSON.parse(cacheService.publish.mock.calls[0][1]);
    expect(published.runningSummary).toBe(TWO_SEGMENT_SUMMARY);
    expect(published.groundedness.verdict).toBe('unverified');

    // PHI hygiene: the failure logs carry no clinical text.
    const gateWarns = warnSpy.mock.calls.filter((c) =>
      String((c[0] as { message?: string })?.message ?? '')
        .toLowerCase()
        .includes('groundedness'),
    );
    expect(gateWarns.length).toBeGreaterThan(0);
    for (const call of gateWarns) {
      expect(JSON.stringify(call[0])).not.toContain('amlodipine');
      expect(JSON.stringify(call[0])).not.toContain('MRI confirmed');
    }
  });

  it('treats a malformed guardrail response as unverified (fail-closed), never grounded', async () => {
    // Case 1: response with no segments array at all.
    const noSegments = buildHttpMock({ ground: () => Promise.resolve({ data: { ok: true } }) });
    const a = buildDeps(noSegments, { config: ENABLED_CONFIG });
    a.service.start({ consultationId: CID, tenantId: TENANT });
    a.service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });
    const payloadA = await a.service.flush(CID);
    expect(payloadA!.groundedness!.verdict).toBe('unverified');

    // Case 2: unknown verdict strings must coerce to `unverified` — a wire value
    // can never smuggle a `grounded` mark past the strict mapper.
    const weirdVerdicts = buildHttpMock({
      ground: () =>
        Promise.resolve({
          data: {
            ...GROUND_WIRE_MIXED,
            segments: [{ text: 'Pt on amlodipine for HTN.', verdict: 'TOTALLY_FINE', grounded: true, start: 0, end: 25 }],
            flagged_spans: [],
          },
        }),
    });
    const b = buildDeps(weirdVerdicts, { config: ENABLED_CONFIG });
    b.service.start({ consultationId: CID, tenantId: TENANT });
    b.service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });
    const payloadB = await b.service.flush(CID);
    expect(payloadB!.groundedness!.verdict).toBe('unverified');
    expect(payloadB!.groundedness!.segments![0].verdict).toBe('unverified');
  });

  it('never trusts checked=false wire responses as grounded even when all segments claim it', async () => {
    const dishonest = buildHttpMock({
      ground: () => Promise.resolve({ data: { ...GROUND_WIRE_ALL_GROUNDED, checked: false, reason: 'nli_model_unavailable' } }),
    });
    const { service } = buildDeps(dishonest, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });
    service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

    const payload = await service.flush(CID);

    expect(payload!.groundedness!.verdict).toBe('unverified');
    // A distrusted (checked:false) response must drive
    // NO grounded segment mark either, not just an unverified rollup: every per-segment
    // verdict is coerced to 'unverified' (the wire claimed all-'grounded').
    expect(payload!.groundedness!.segments.length).toBeGreaterThan(0);
    expect(payload!.groundedness!.segments.every((s) => s.verdict === 'unverified')).toBe(true);
  });

  // ------------------------------------------------------------------
  // P0-A interplay: a generation superseded DURING the groundedness check must
  // not publish out of order.
  // ------------------------------------------------------------------
  it('drops a stale generation superseded during the groundedness check', async () => {
    let groundCallCount = 0;
    let releaseFirstGround!: () => void;
    const firstGroundGate = new Promise<void>((resolve) => {
      releaseFirstGround = resolve;
    });
    let smrCalls = 0;
    const httpMock = {
      axiosRef: {
        post: vi.fn().mockImplementation((url: string) => {
          if (url.includes('/guardrail/ground')) {
            groundCallCount += 1;
            if (groundCallCount === 1) return firstGroundGate.then(() => ({ data: GROUND_WIRE_ALL_GROUNDED }));
            return Promise.resolve({ data: GROUND_WIRE_ALL_GROUNDED });
          }
          if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
          if (url.includes('/generate')) {
            smrCalls += 1;
            return Promise.resolve({ data: { summary: smrCalls === 1 ? 'STALE first' : 'FRESH second' } });
          }
          return Promise.resolve({ data: {} });
        }),
      },
    } as unknown as ReturnType<typeof buildHttpMock>;
    const { service, cacheService } = buildDeps(httpMock, { config: ENABLED_CONFIG });
    service.start({ consultationId: CID, tenantId: TENANT });

    service.ingestSegment(CID, { text: 'first', isFinal: true, segmentId: 's1' });
    const p1 = service.flush(CID); // generation 1 — hangs inside the groundedness check
    await new Promise((r) => setTimeout(r, 10)); // let gen 1 reach /guardrail/ground
    service.ingestSegment(CID, { text: 'second', isFinal: true, segmentId: 's2' });
    const p2 = service.flush(CID); // generation 2 — supersedes
    await p2;

    releaseFirstGround(); // stale gate resolves AFTER the fresh publish
    await p1;

    const publishedSummaries = cacheService.publish.mock.calls
      .map((c: unknown[]) => JSON.parse(c[1] as string))
      .filter((p: { closed?: boolean }) => p.closed !== true)
      .map((p: { runningSummary: string }) => p.runningSummary);
    expect(publishedSummaries).toContain('FRESH second');
    expect(publishedSummaries).not.toContain('STALE first');
  });
});
