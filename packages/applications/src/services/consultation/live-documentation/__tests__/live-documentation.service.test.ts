/**
 * LiveDocumentationService Unit Tests
 *
 * Covers the net-new realtime watcher behaviour:
 *   - debounce: flush at the segment threshold (~3 final segments)
 *   - debounce: flush on the idle timer (~5s) for a trailing segment
 *   - aggregate/payload shaping: SMR running summary + NLP entities → SSE payload
 *   - SMR/NLP fault tolerance (a down service keeps the prior value)
 *   - SSE relay: stored snapshot emitted first, then channel messages relayed
 *   - interim (non-final) segments are ignored
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-001';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:live-summary:${CID}`;

/** A promise whose resolution is deferred to the test body (overlap simulation). */
function makeDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function buildHttpMock() {
  return {
    axiosRef: {
      post: vi.fn().mockImplementation((url: string) => {
        if (url.includes('/classify/tokens')) {
          // Canonical NLP wire shape (apps/nlp schemas/common.py Entity): text / entity_type / position.{start,end}.
          return Promise.resolve({ data: { entities: [{ entity_type: 'MEDICATION', text: 'amlodipine', confidence: 0.92, position: { start: 3, end: 13 } }] } });
        }
        if (url.includes('/generate')) {
          return Promise.resolve({ data: { summary: 'Pt on amlodipine for HTN.' } });
        }
        return Promise.resolve({ data: {} });
      }),
    },
  };
}

interface BuildDepsOpts {
  /** `LIVE_DOC_*` config overrides (read by the constructor via ConfigService.get). */
  config?: Record<string, unknown>;
  redisSubscriber?: any;
  contextItemRepository?: any;
  // Shared cache mock — pass the SAME instance to two services to exercise the
  // cross-instance owner lock (C5-06).
  cacheService?: any;
  // HarnessPolicy resolver override (defaults to a passing stub).
  harnessPolicyService?: any;
  // Vault-Transit encryption service — undefined by default (matches every
  // other buildDeps fixture's soft-no-op posture in dev/test).
  secretsService?: any;
}

function buildDeps(httpMock = buildHttpMock(), opts: BuildDepsOpts = {}) {
  const cacheService = opts.cacheService ?? {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    // Default: acquire succeeds. Anything other than an explicit `0` reads as
    // "acquired" so existing single-instance tests keep starting their watchers.
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const redisSubscriber = opts.redisSubscriber ?? {
    subscribeToChannel: vi.fn(),
    unsubscribeFromChannel: vi.fn(),
  };
  const audioBridge = {
    subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }),
    unsubscribeFromResults: vi.fn(),
  };
  const contextItemRepository = opts.contextItemRepository ?? {
    create: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    update: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    findTranscripts: vi.fn().mockResolvedValue([]),
    // Deterministic durable-snapshot dedup hooks (C5-06 / I-1) — default: no rows.
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    findPreSummaries: vi.fn().mockResolvedValue([]),
  };
  const config = opts.config ?? {};
  const configService = { get: vi.fn().mockImplementation((key: string) => config[key]) };
  // Live-doc resolves provider+model via the HarnessPolicy cascade
  // (not env). Default stub resolves successfully so SMR-path tests still flow.
  const harnessPolicyService = opts.harnessPolicyService ?? {
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

  return { service, cacheService, redisSubscriber, audioBridge, contextItemRepository, httpMock, harnessPolicyService, secretsService };
}

describe('LiveDocumentationService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('debounce', () => {
    it('flushes once the segment threshold (3 finals) is reached', () => {
      const { service } = buildDeps();
      const flushSpy = vi.spyOn(service, 'flush').mockResolvedValue(null);

      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'one', isFinal: true, segmentId: 's1' });
      service.ingestSegment(CID, { text: 'two', isFinal: true, segmentId: 's2' });
      expect(flushSpy).not.toHaveBeenCalled();

      service.ingestSegment(CID, { text: 'three', isFinal: true, segmentId: 's3' });
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(flushSpy).toHaveBeenCalledWith(CID);
    });

    it('flushes a trailing segment after the idle debounce window (5s)', () => {
      vi.useFakeTimers();
      const { service } = buildDeps();
      const flushSpy = vi.spyOn(service, 'flush').mockResolvedValue(null);

      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'only one', isFinal: true, segmentId: 's1' });
      expect(flushSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores interim (non-final) segments and unknown consultations', async () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'interim words', isFinal: false });
      expect(() => service.ingestSegment('does-not-exist', { text: 'x', isFinal: true })).not.toThrow();

      const payload = await service.flush(CID);
      expect(payload).toBeNull();
    });
  });

  describe('aggregate + payload shaping', () => {
    it('builds the SSE payload from SMR summary + NLP entities and publishes it', async () => {
      const { service, cacheService } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 'seg-42' });

      const payload = await service.flush(CID);

      expect(payload).not.toBeNull();
      expect(payload!.consultationId).toBe(CID);
      expect(payload!.runningSummary).toBe('Pt on amlodipine for HTN.');
      // NER runs over the transcript; the entity is GROUNDED (re-located) into the note,
      // so start/end index 'amlodipine' within "Pt on amlodipine for HTN." (offset 6), not the raw NER offset.
      expect(payload!.entities).toEqual([{ text: 'amlodipine', type: 'MEDICATION', confidence: 0.92, start: 6, end: 16 }]);
      expect(payload!.sections).toEqual([{ title: 'Running Summary', content: 'Pt on amlodipine for HTN.' }]);
      expect(payload!.lastSegmentId).toBe('seg-42');
      expect(typeof payload!.updatedAt).toBe('string');

      expect(cacheService.publish).toHaveBeenCalledWith(CHANNEL, expect.any(String));
      expect(cacheService.setex).toHaveBeenCalled();
      const published = JSON.parse(cacheService.publish.mock.calls[0][1]);
      expect(published.consultationId).toBe(CID);
      expect(published.runningSummary).toBe('Pt on amlodipine for HTN.');
    });

    it('tolerates an NLP outage and keeps the SMR summary', async () => {
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.reject(new Error('nlp down'));
            return Promise.resolve({ data: { summary: 'Summary only.' } });
          }),
        },
      };
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);
      expect(payload!.runningSummary).toBe('Summary only.');
      expect(payload!.entities).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // C5-01: the NLP `/classify/tokens` wire contract. The service
  // must read the canonical NLP fields (text / entity_type / position.{start,end})
  // — NOT the never-emitted value/type/start/end — and re-key them onto the
  // highlight DTO (entity_type → type). Genuinely-missing fields fall back.
  // ------------------------------------------------------------------
  describe('NLP contract mapping', () => {
    it('maps the canonical NLP wire shape onto the highlight DTO, grounds it into the note, and drops the un-anchorable fallback', async () => {
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) {
              return Promise.resolve({
                data: {
                  entities: [
                    { entity_type: 'CONDITION', text: 'hypertension', confidence: 0.81, position: { start: 5, end: 17 } },
                    { confidence: 0.4 }, // no entity_type/text/position → safe fallbacks
                  ],
                },
              });
            }
            if (url.includes('/generate')) return Promise.resolve({ data: { summary: 'Patient has hypertension noted.' } });
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'has hypertension', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      // CallNlp maps the canonical wire shape (entity_type→type, confidence carried); the
      // entity is then grounded into the note, so start/end index 'hypertension' at offset 12.
      expect(payload!.entities).toEqual([{ text: 'hypertension', type: 'CONDITION', confidence: 0.81, start: 12, end: 24 }]);
      // The missing-field fallback entity (text:'') has no surface form to anchor and is dropped by grounding.
    });
  });

  describe('structured S/O/A/P sections (follow-up 1)', () => {
    const SOAP = [
      'Subjective: Patient reports chest pain since this morning.',
      'Objective: BP 150/95, HR 88.',
      'Assessment: Likely hypertensive episode.',
      'Plan: Start amlodipine 5mg, follow up in one week.',
    ].join('\n');

    function soapHttpMock() {
      return {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string, body: { text?: string }) => {
            if (url.includes('/classify/tokens')) {
              const text = body?.text ?? '';
              const start = text.indexOf('amlodipine');
              return Promise.resolve({
                data: { entities: [{ entity_type: 'MEDICATION', text: 'amlodipine', confidence: 0.9, position: { start, end: start + 'amlodipine'.length } }] },
              });
            }
            if (url.includes('/generate')) return Promise.resolve({ data: { summary: SOAP } });
            return Promise.resolve({ data: {} });
          }),
        },
      };
    }

    it('emits the four ordered SOAP sections parsed from the SMR output', async () => {
      const { service } = buildDeps(soapHttpMock());
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient has chest pain', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      expect(payload!.sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
      expect(payload!.sections[0].content).toBe('Patient reports chest pain since this morning.');
      expect(payload!.sections[3].content).toBe('Start amlodipine 5mg, follow up in one week.');
      // runningSummary kept for backward-compat (flat join of the section bodies).
      expect(payload!.runningSummary).toContain('Start amlodipine 5mg, follow up in one week.');
    });

    it('runs NER over the transcript delta and grounds entity offsets into the rendered note', async () => {
      const httpMock = soapHttpMock();
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient has chest pain', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      // NER is handed the raw transcript delta (the text that feeds SMR), NOT the note.
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'))!;
      expect(nlpCall[1].text).toBe('Patient has chest pain');
      expect(nlpCall[1].text).not.toBe(payload!.runningSummary);

      // The published entity is grounded, so its offsets resolve to the exact span within runningSummary.
      const entity = payload!.entities[0];
      expect(payload!.runningSummary.slice(entity.start!, entity.end!)).toBe('amlodipine');
    });

    it('falls back to a single "Running Summary" section for unstructured SMR output', async () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);
      expect(payload!.sections).toEqual([{ title: 'Running Summary', content: 'Pt on amlodipine for HTN.' }]);
    });
  });

  // ------------------------------------------------------------------
  // AD-1 generation stats on the live-summary SSE payload.
  // The SMR /generate response now carries a `stats` block; each flush must
  // surface it as `metadata.stats` on the published payload so the console /
  // gateway wave can render TTFT / tok-s / stop-reason live. Null / missing
  // stats (legacy idempotency-cache hit) must degrade cleanly — no metadata,
  // feed still publishes.
  // ------------------------------------------------------------------
  describe('generation stats on the SSE payload', () => {
    function statsHttpMock(stats: unknown) {
      return {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) return Promise.resolve({ data: { summary: 'Running note.', stats } });
            return Promise.resolve({ data: {} });
          }),
        },
      };
    }

    const POPULATED_STATS = {
      stop_reason: 'stop',
      stop_reason_raw: 'stop',
      total_ms: 900,
      ttft_ms: 120,
      tokens_per_second: 33.3,
      prompt_tokens: 80,
      predicted_tokens: 40,
      total_tokens: 120,
      provider: 'vllm',
      model: 'live-medgemma',
      engine_native: null,
    };

    it('attaches AD-1 stats to metadata.stats on the flush payload', async () => {
      const { service } = buildDeps(statsHttpMock(POPULATED_STATS));
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      expect(payload!.metadata?.stats).toMatchObject({
        stop_reason: 'stop',
        ttft_ms: 120,
        tokens_per_second: 33.3,
        prompt_tokens: 80,
        predicted_tokens: 40,
        total_tokens: 120,
        provider: 'vllm',
        model: 'live-medgemma',
      });
    });

    it('publishes the stats to the live-summary channel', async () => {
      const { service, cacheService } = buildDeps(statsHttpMock(POPULATED_STATS));
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      await service.flush(CID);

      const published = JSON.parse(cacheService.publish.mock.calls[0][1] as string);
      expect(published.metadata.stats.stop_reason).toBe('stop');
      expect(published.metadata.stats.tokens_per_second).toBe(33.3);
    });

    it('degrades cleanly when SMR omits stats — no metadata.stats, feed still publishes', async () => {
      const { service, cacheService } = buildDeps(statsHttpMock(null));
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      expect(payload!.metadata?.stats ?? null).toBeNull();
      expect(cacheService.publish).toHaveBeenCalledWith(CHANNEL, expect.any(String));
    });
  });

  describe('stop', () => {
    it('persists a PRE_SUMMARY snapshot when requested and tears the session down', async () => {
      const { service, contextItemRepository, cacheService } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT, userId: 'doc-1' });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

      const final = await service.stop(CID, { persistSnapshot: true });

      expect(final).not.toBeNull();
      expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
      // terminal closed marker published
      const lastPublish = cacheService.publish.mock.calls.at(-1)![1];
      expect(JSON.parse(lastPublish).closed).toBe(true);
      expect(service.isActive(CID)).toBe(false);
    });
  });

  describe('SSE relay (subscribeToLiveSummary)', () => {
    it('emits the stored snapshot first then relays channel messages', async () => {
      const { service, cacheService, redisSubscriber } = buildDeps();
      const snapshot = JSON.stringify({ consultationId: CID, runningSummary: 'snap', sections: [], entities: [], updatedAt: 'now' });
      cacheService.get.mockResolvedValue(snapshot);
      const channel$ = new Subject<string>();
      redisSubscriber.subscribeToChannel.mockResolvedValue(channel$.asObservable());

      const events: Array<{ data: string }> = [];
      const sub = service.subscribeToLiveSummary(CID).subscribe((e: any) => events.push(e));

      await new Promise((r) => setTimeout(r, 10));
      expect(events[0].data).toBe(snapshot);

      channel$.next(JSON.stringify({ consultationId: CID, runningSummary: 'updated' }));
      await new Promise((r) => setTimeout(r, 10));
      expect(events[1].data).toContain('updated');

      sub.unsubscribe();
      expect(redisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith(CHANNEL);
    });
  });

  // ------------------------------------------------------------------
  // P0-A: overlapping generations, abort, throttle
  // ------------------------------------------------------------------
  describe('overlapping flushes', () => {
    it('drops a stale in-flight generation when a newer flush supersedes it (no out-of-order publish)', async () => {
      const deferred = makeDeferred();
      let smrCalls = 0;
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              smrCalls += 1;
              if (smrCalls === 1) return deferred.promise.then(() => ({ data: { summary: 'STALE first' } }));
              return Promise.resolve({ data: { summary: 'FRESH second' } });
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service, cacheService } = buildDeps(httpMock, { config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'first', isFinal: true, segmentId: 's1' });
      const p1 = service.flush(CID); // generation 1 — SMR hangs
      service.ingestSegment(CID, { text: 'second', isFinal: true, segmentId: 's2' });
      const p2 = service.flush(CID); // generation 2 — supersedes; SMR resolves immediately
      await p2;

      deferred.resolve(); // release the stale first call AFTER the fresh one published
      await p1;

      const publishedSummaries = cacheService.publish.mock.calls
        .map((c: unknown[]) => JSON.parse(c[1] as string))
        .filter((p: { closed?: boolean }) => p.closed !== true)
        .map((p: { runningSummary: string }) => p.runningSummary);
      expect(publishedSummaries).toContain('FRESH second');
      expect(publishedSummaries).not.toContain('STALE first');
      // last non-terminal payload reflects the fresh generation
      expect(publishedSummaries.at(-1)).toBe('FRESH second');
    });

    it('throttles live SMR calls to at most one per LIVE_DOC_MIN_INTERVAL_MS', async () => {
      vi.useFakeTimers();
      const { service, httpMock } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_MIN_INTERVAL_MS: '4000' } });
      const generateCalls = () => httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate')).length;

      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'a', isFinal: true, segmentId: 's1' });
      await service.flush(CID);
      expect(generateCalls()).toBe(1);

      // A 2nd flush inside the window must be throttled (scheduled, no SMR call yet).
      service.ingestSegment(CID, { text: 'b', isFinal: true, segmentId: 's2' });
      await service.flush(CID);
      expect(generateCalls()).toBe(1);

      // Once the window elapses, the scheduled trailing flush fires.
      await vi.advanceTimersByTimeAsync(4000);
      expect(generateCalls()).toBe(2);
    });

    it('passes an abort signal to the SMR and NLP calls so in-flight work can be cancelled', async () => {
      const { service, httpMock } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      const smrCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/generate'))!;
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/classify/tokens'))!;
      expect((smrCall[2] as { signal?: unknown }).signal).toBeDefined();
      expect((nlpCall[2] as { signal?: unknown }).signal).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // P0-B: incremental prompt + bounded SMR params
  // ------------------------------------------------------------------
  describe('bounded transcript cost', () => {
    it('sends an incremental prompt (prior note + new delta only) on subsequent flushes', async () => {
      const { service, httpMock } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'Patient reports cough', isFinal: true, segmentId: 's1' });
      await service.flush(CID); // first flush — full transcript
      service.ingestSegment(CID, { text: 'and mild fever', isFinal: true, segmentId: 's2' });
      await service.flush(CID); // second flush — incremental

      const generateCalls = httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate'));
      const secondPrompt = generateCalls[1][1].prompt as string;
      expect(secondPrompt).toContain('and mild fever'); // new delta
      expect(secondPrompt).toContain('Pt on amlodipine for HTN.'); // prior SOAP note carried forward
      expect(secondPrompt).not.toContain('Patient reports cough'); // old transcript NOT re-sent verbatim
    });

    it('sets bounded live SMR params (max_tokens, lower timeout) and resolves provider/model via policy', async () => {
      const harnessPolicyService = {
        resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'fast-model' }),
      };
      const { service, httpMock } = buildDeps(buildHttpMock(), {
        config: {
          LIVE_DOC_SMR_MAX_TOKENS: '1500',
          LIVE_DOC_SMR_TIMEOUT_MS: '20000',
        },
        harnessPolicyService,
      });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      // Provider+model come from the policy cascade (keyed by the session tenant),
      // not LIVE_DOC_SMR_PROVIDER/MODEL env. The live flush must ask
      // for the LIVE tier ('smr.live'), not the default finalize tier.
      expect(harnessPolicyService.resolveSmrSelection).toHaveBeenCalledWith(TENANT, 'live');
      const smrCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/generate'))!;
      const body = smrCall[1] as { max_tokens?: number; provider?: string; model?: string; response_format?: { type?: string } };
      const config = smrCall[2] as { timeout?: number };
      expect(body.max_tokens).toBe(1500);
      expect(body.provider).toBe('openai');
      expect(body.model).toBe('fast-model');
      expect(body.response_format?.type).toBe('json_schema');
      expect(config.timeout).toBe(20000);
    });
  });

  // ------------------------------------------------------------------
  // C5-04: long-transcript truncation must not permanently drop the head.
  // When the un-flushed delta exceeds MAX_DELTA_CHARS the OLD code kept the
  // TAIL (`slice(-MAX)`) and then advanced the cursor to the full length, so
  // the early clinical content (chief complaint / allergies stated first) was
  // dropped from the prompt AND never re-sent. The fix keeps the HEAD and
  // carries the overflow forward (cursor advances only over what was sent).
  // ------------------------------------------------------------------
  describe('long-transcript truncation carry-forward', () => {
    const HEAD_MARKER = 'CHIEFCOMPLAINT allergy penicillin anaphylaxis';

    /** An httpMock that records every SMR `/generate` prompt. */
    function recordingHttpMock(prompts: string[]) {
      return {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string, body: { prompt?: string }) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              prompts.push(String(body?.prompt ?? ''));
              return Promise.resolve({ data: { summary: 'Running SOAP note.' } });
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
    }

    /** Push the head marker + enough filler to drive the joined delta past MAX_DELTA_CHARS (12000). */
    function ingestOversizedBacklog(service: LiveDocumentationService) {
      service.ingestSegment(CID, { text: HEAD_MARKER, isFinal: true, segmentId: 'head' });
      for (let i = 0; i < 320; i++) {
        service.ingestSegment(CID, { text: `filler segment number ${i} describing ongoing symptoms in detail`, isFinal: true, segmentId: `f${i}` });
      }
    }

    it('keeps early clinical content across flushes when the delta exceeds MAX_DELTA_CHARS (no permanent head loss)', async () => {
      const prompts: string[] = [];
      // High segment threshold so ingest never auto-flushes — the test controls flush timing.
      const { service } = buildDeps(recordingHttpMock(prompts), {
        config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_SEGMENT_THRESHOLD: '100000' },
      });
      service.start({ consultationId: CID, tenantId: TENANT });

      ingestOversizedBacklog(service);
      await service.flush(CID); // first flush — backlog > 12k, must truncate

      // Realistic continuous stream: new content keeps arriving, so a later flush
      // has a non-empty delta and never falls back to re-sending the whole transcript.
      service.ingestSegment(CID, { text: 'TAILMARKER new symptom just now', isFinal: true, segmentId: 'tail' });
      await service.flush(CID); // second flush — incremental

      // The early clinical content must have reached SMR in SOME flush (kept as the
      // head + carried forward), not silently dropped forever.
      expect(prompts.some((p) => p.includes(HEAD_MARKER))).toBe(true);
    });

    it('logs a PHI-safe truncation counter (sizes/counts only, no transcript text)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const prompts: string[] = [];
      const { service } = buildDeps(recordingHttpMock(prompts), {
        config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_SEGMENT_THRESHOLD: '100000' },
      });
      service.start({ consultationId: CID, tenantId: TENANT });

      ingestOversizedBacklog(service);
      await service.flush(CID);

      const truncWarn = warnSpy.mock.calls.find((c) => String((c[0] as { message?: string })?.message ?? '').toLowerCase().includes('truncat'));
      expect(truncWarn).toBeDefined();
      // PHI-safe: the truncation log carries counts/sizes only, never transcript text.
      expect(JSON.stringify(truncWarn![0])).not.toContain(HEAD_MARKER);
      expect(JSON.stringify(truncWarn![0])).not.toContain('filler segment');
    });
  });

  // ------------------------------------------------------------------
  // P0-C: deterministic json_schema SOAP parse in the flush path
  // ------------------------------------------------------------------
  describe('deterministic SOAP parse', () => {
    it('parses a SOAP JSON SMR response into the four ordered sections (no regex dependency)', async () => {
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              return Promise.resolve({
                data: { summary: JSON.stringify({ subjective: 'S text', objective: 'O text', assessment: 'A text', plan: 'P text' }) },
              });
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'chest pain', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);
      expect(payload!.sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
      expect(payload!.sections[0].content).toBe('S text');
      expect(payload!.sections[3].content).toBe('P text');
    });
  });

  // ------------------------------------------------------------------
  // P1-A: resilient subset — cross-instance stop + control teardown
  // ------------------------------------------------------------------
  describe('cross-instance resilience', () => {
    it('publishes a terminal closed event, attempts a FENCED lock release, and signals teardown even with no local session', async () => {
      const { service, cacheService } = buildDeps();
      const result = await service.stop('other-cid');

      expect(result).toBeNull();
      const publishes = cacheService.publish.mock.calls.map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]);
      // terminal closed on the main channel
      expect(publishes.some(([ch, p]: [string, { closed?: boolean }]) => ch === 'consultation:live-summary:other-cid' && p.closed === true)).toBe(true);
      // stop signal on the control channel (so an owner on another instance tears down)
      expect(publishes.some(([ch, p]: [string, { type?: string }]) => ch === 'consultation:live-summary:other-cid:control' && p.type === 'stop')).toBe(true);
      // Owner lock release is FENCED (C5-06): a non-owner never blindly `del`s the
      // lock — it runs the compare-and-delete Lua so only the real owner's lock is freed.
      expect(cacheService.eval).toHaveBeenCalledWith(
        expect.stringContaining('live-doc:lock:release'),
        1,
        'consultation:live-summary:other-cid:lock',
        expect.any(String),
      );
      expect(cacheService.del).not.toHaveBeenCalledWith('consultation:live-summary:other-cid:lock');
    });

    it('tears down the local session when a cross-instance stop signal arrives on the control channel', async () => {
      const control$ = new Subject<string>();
      const redisSubscriber = {
        subscribeToChannel: vi.fn().mockResolvedValue(control$.asObservable()),
        unsubscribeFromChannel: vi.fn(),
      };
      const { service } = buildDeps(buildHttpMock(), { redisSubscriber });
      service.start({ consultationId: CID, tenantId: TENANT });
      // let the async control-channel subscription establish
      await new Promise((r) => setTimeout(r, 10));
      expect(service.isActive(CID)).toBe(true);

      control$.next(JSON.stringify({ type: 'stop' }));
      await new Promise((r) => setTimeout(r, 10));

      expect(service.isActive(CID)).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // C5-06: single-owner lock must be a real atomic acquire (SET NX), fenced on
  // release/renew, and the durable snapshot must dedup deterministically — so a
  // second instance can neither run a duplicate watcher (duplicate SMR spend)
  // nor write a second PRE_SUMMARY row.
  // ------------------------------------------------------------------
  describe('single-owner lock: mutual exclusion + fencing + dedup', () => {
    /** An in-memory cache whose `eval` implements the atomic CAS lock scripts. Share one across instances. */
    function makeSharedCacheMock() {
      const store = new Map<string, string>();
      return {
        store,
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
        set: vi.fn().mockImplementation((k: string, v: string) => {
          store.set(k, v);
          return Promise.resolve(undefined);
        }),
        setex: vi.fn().mockImplementation((k: string, _ttl: number, v: string) => {
          store.set(k, v);
          return Promise.resolve(undefined);
        }),
        publish: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockImplementation((k: string) => {
          store.delete(k);
          return Promise.resolve(undefined);
        }),
        sadd: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
        smembers: vi.fn().mockResolvedValue([]),
        expire: vi.fn().mockResolvedValue(true),
        // Atomic lock primitives — dispatched by the script's tag comment. The
        // store mutation happens synchronously at call time, so two racing
        // acquires resolve deterministically (exactly one wins), exactly as
        // Redis serialises the Lua body.
        eval: vi.fn().mockImplementation((script: string, _numKeys: number, ...args: (string | number)[]) => {
          const key = String(args[0]);
          const val = String(args[1]);
          if (script.includes('live-doc:lock:acquire')) {
            const cur = store.get(key);
            if (cur === undefined || cur === val) {
              store.set(key, val);
              return Promise.resolve(1);
            }
            return Promise.resolve(0);
          }
          if (script.includes('live-doc:lock:release')) {
            if (store.get(key) === val) {
              store.delete(key);
              return Promise.resolve(1);
            }
            return Promise.resolve(0);
          }
          if (script.includes('live-doc:lock:renew')) {
            return Promise.resolve(store.get(key) === val ? 1 : 0);
          }
          return Promise.resolve(null);
        }),
      };
    }

    /**
     * A repo backed by an in-memory row list. `findLatestPreSummary` faithfully
     * models the REAL (generated) ContextItemRepository contract — the newest
     * PRE_SUMMARY of ANY subType, NOT subType-aware (this is the I-1 bug lever) —
     * while `findPreSummaries` returns every row for the fixed subType-filtering
     * dedup. Share one across instances.
     */
    function makeSharedRepo() {
      const rows: any[] = [];
      return {
        rows,
        create: vi.fn().mockImplementation((entity: any) => {
          rows.push(entity);
          return Promise.resolve(entity);
        }),
        update: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
        findTranscripts: vi.fn().mockResolvedValue([]),
        // Real contract: newest PRE_SUMMARY regardless of subType (insertion order
        // models createdAt order). Subtype-blind — the lever the I-1 fix must survive.
        findLatestPreSummary: vi.fn().mockImplementation(() => Promise.resolve(rows.length ? rows[rows.length - 1] : null)),
        // All pre-summaries — the fixed dedup filters these by subType itself.
        findPreSummaries: vi.fn().mockImplementation(() => Promise.resolve([...rows])),
      };
    }

    it('acquires the owner lock with SET NX so a second instance bails out of start() (no duplicate SMR call)', async () => {
      const sharedCache = makeSharedCacheMock();
      const sharedRepo = makeSharedRepo();
      const sharedHttp = buildHttpMock();
      const config = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
      const a = buildDeps(sharedHttp, { cacheService: sharedCache, contextItemRepository: sharedRepo, config });
      const b = buildDeps(sharedHttp, { cacheService: sharedCache, contextItemRepository: sharedRepo, config });

      a.service.start({ consultationId: CID, tenantId: TENANT });
      b.service.start({ consultationId: CID, tenantId: TENANT });
      // Let both fire-and-forget claimOwnership() coroutines settle.
      await new Promise((r) => setTimeout(r, 20));

      // Exactly one instance owns the session; the loser bailed out of start().
      expect(a.service.isActive(CID)).toBe(true);
      expect(b.service.isActive(CID)).toBe(false);

      const generateCalls = () => sharedHttp.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate')).length;
      a.service.ingestSegment(CID, { text: 'chest pain', isFinal: true, segmentId: 's1' });
      b.service.ingestSegment(CID, { text: 'chest pain', isFinal: true, segmentId: 's1' }); // no-op — no session
      await a.service.flush(CID);
      await b.service.flush(CID); // null — no session, no SMR

      // One consultation → exactly ONE SMR /generate call, not two.
      expect(generateCalls()).toBe(1);
    });

    it('dedups by subType so a newer NON-live PRE_SUMMARY cannot spawn a duplicate LIVE_SOAP_SNAPSHOT', async () => {
      const sharedRepo = makeSharedRepo();
      const config = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
      // SEPARATE caches → both instances run (lock defeated / a restart re-opens the
      // consultation). The durable dedup must be the backstop.
      const a = buildDeps(buildHttpMock(), { contextItemRepository: sharedRepo, config });
      const b = buildDeps(buildHttpMock(), { contextItemRepository: sharedRepo, config });

      // 1) Instance A persists the live snapshot row (T1).
      a.service.start({ consultationId: CID, tenantId: TENANT, userId: 'doc-a' });
      a.service.ingestSegment(CID, { text: 'chest pain', isFinal: true, segmentId: 's1' });
      await a.service.stop(CID, { persistSnapshot: true });

      // 2) A NON-live PRE_SUMMARY is minted afterwards (e.g. the pre-summary
      //    processor / case-note summary) — newer than the live row, different subType.
      sharedRepo.rows.push({ id: 'ctx-nonlive-presummary', metaData: { subType: 'CASE_NOTE_SUMMARY' } });

      // 3) Instance B re-opens the consultation (fresh session, snapshotEntity === null)
      //    and persists. A subType-BLIND finder returns the T2 non-live row and creates
      //    a SECOND live snapshot; the subType-aware dedup must reuse A's row instead.
      b.service.start({ consultationId: CID, tenantId: TENANT, userId: 'doc-b' });
      b.service.ingestSegment(CID, { text: 'more findings', isFinal: true, segmentId: 's2' });
      await b.service.stop(CID, { persistSnapshot: true });

      // Exactly ONE LIVE_SOAP_SNAPSHOT row exists across the whole consultation.
      const liveSnapshots = sharedRepo.rows.filter((r) => (r.metaData as { subType?: string })?.subType === 'LIVE_SOAP_SNAPSHOT');
      expect(liveSnapshots).toHaveLength(1);
      // Dedup went through the subType-aware finder, not the subType-blind one.
      expect(sharedRepo.findPreSummaries).toHaveBeenCalled();
    });

    it('periodically renews the owner lock with a fenced compare-and-expire while the session is live', async () => {
      vi.useFakeTimers();
      const sharedCache = makeSharedCacheMock();
      const { service } = buildDeps(buildHttpMock(), { cacheService: sharedCache, config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
      service.start({ consultationId: CID, tenantId: TENANT });
      // Let claimOwnership acquire + schedule the renewal interval.
      await vi.advanceTimersByTimeAsync(0);
      expect(service.isActive(CID)).toBe(true);

      sharedCache.eval.mockClear();
      // Advance one renewal interval (LOCK_TTL / 2 = 1800s).
      await vi.advanceTimersByTimeAsync(1_800_000);

      const renewCall = sharedCache.eval.mock.calls.find((c: unknown[]) => String(c[0]).includes('live-doc:lock:renew'));
      expect(renewCall).toBeDefined();
      expect(renewCall![2]).toBe('consultation:live-summary:consultation-001:lock');

      await service.stop(CID);
    });

    it('stands down the watcher when a renewal finds the owner lock was lost', async () => {
      vi.useFakeTimers();
      const sharedCache = makeSharedCacheMock();
      const { service } = buildDeps(buildHttpMock(), { cacheService: sharedCache, config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
      service.start({ consultationId: CID, tenantId: TENANT });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.isActive(CID)).toBe(true);

      // Simulate a foreign takeover: overwrite the lock value so our fenced renew returns 0.
      sharedCache.store.set('consultation:live-summary:consultation-001:lock', 'some-other-instance-id');

      // One renewal interval → renew returns 0 (lost) → the watcher must stand down.
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(service.isActive(CID)).toBe(false);
      // Fenced: we did NOT delete the new owner's lock.
      expect(sharedCache.store.get('consultation:live-summary:consultation-001:lock')).toBe('some-other-instance-id');

      vi.useRealTimers();
    });
  });

  // ------------------------------------------------------------------
  // I-2: stop() must drain a > MAX_DELTA_CHARS backlog, not single-flush it —
  // otherwise the final durable snapshot keeps only the head 12k and drops the
  // most-recent transcript (assessment / plan / closing).
  // ------------------------------------------------------------------
  describe('stop() drains the full backlog', () => {
    it('keeps the most-recent transcript in the final snapshot when the backlog exceeds MAX_DELTA_CHARS', async () => {
      const prompts: string[] = [];
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string, body: { prompt?: string }) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              prompts.push(String(body?.prompt ?? ''));
              return Promise.resolve({ data: { summary: 'Running SOAP note.' } });
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
      // High segment threshold so ingest never auto-flushes — the whole backlog is
      // un-flushed at stop().
      const { service } = buildDeps(httpMock, { config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_SEGMENT_THRESHOLD: '100000' } });
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'HEADMARKER chief complaint', isFinal: true, segmentId: 'h' });
      for (let i = 0; i < 320; i++) {
        service.ingestSegment(CID, { text: `filler segment number ${i} describing ongoing symptoms in detail`, isFinal: true, segmentId: `f${i}` });
      }
      service.ingestSegment(CID, { text: 'TAILMARKER assessment and plan', isFinal: true, segmentId: 't' });

      // No manual flush — stop() alone must drain the > 12k backlog.
      await service.stop(CID, { persistSnapshot: true });

      // The most-recent content (the tail) reached SMR — not dropped by a single
      // head-only flush. (The head is retained by C5-04; the tail is the I-2 case.)
      expect(prompts.some((p) => p.includes('TAILMARKER assessment and plan'))).toBe(true);
      expect(prompts.some((p) => p.includes('HEADMARKER chief complaint'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // P1-C: throttled durable snapshot (single upserted ContextItem)
  // ------------------------------------------------------------------
  describe('durable snapshot', () => {
    it('persists a single upserted PRE_SUMMARY snapshot (create once, then updates the same row), throttled', async () => {
      vi.useFakeTimers();
      const created: Array<{ type: string; metaData?: Record<string, unknown> }> = [];
      const repo = {
        create: vi.fn().mockImplementation((entity: { type: string; metaData?: Record<string, unknown> }) => {
          created.push(entity);
          return Promise.resolve(entity);
        }),
        update: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
        findTranscripts: vi.fn().mockResolvedValue([]),
        findLatestPreSummary: vi.fn().mockResolvedValue(null),
        findPreSummaries: vi.fn().mockResolvedValue([]),
      };
      const { service } = buildDeps(buildHttpMock(), {
        config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '1000' },
        contextItemRepository: repo,
      });
      service.start({ consultationId: CID, tenantId: TENANT });

      // First flush at T0 is inside the durable window (baseline set at start) → no write.
      service.ingestSegment(CID, { text: 'a', isFinal: true, segmentId: 's1' });
      await service.flush(CID);
      expect(repo.create).toHaveBeenCalledTimes(0);

      // Cross the window → first durable write = create.
      vi.advanceTimersByTime(1200);
      service.ingestSegment(CID, { text: 'b', isFinal: true, segmentId: 's2' });
      await service.flush(CID);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(created[0].type).toBe('PRE_SUMMARY');
      expect(created[0].metaData).toMatchObject({ subType: 'LIVE_SOAP_SNAPSHOT' });

      // Cross again → upsert the SAME row (update, not a 2nd create).
      vi.advanceTimersByTime(1200);
      service.ingestSegment(CID, { text: 'c', isFinal: true, segmentId: 's3' });
      await service.flush(CID);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledTimes(1);

      // Final-on-stop finalizes the same row (update), never a 2nd create.
      await service.stop(CID, { persistSnapshot: true });
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    // F-031 lane 10: the plaintext `content` column was dropped by the PHI
    // field-encryption migration — persistDurableSnapshot must encrypt the
    // running summary into `encryptedContent` before EVERY create/update, or
    // the in-progress LIVE_SOAP_SNAPSHOT is silently unpersisted at rest.
    it('encrypts the running summary into the ContextItem before every create/update', async () => {
      vi.useFakeTimers();
      const secretsService = { getSecretOptional: vi.fn() };
      const repo = {
        create: vi.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
        update: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
        findTranscripts: vi.fn().mockResolvedValue([]),
        findLatestPreSummary: vi.fn().mockResolvedValue(null),
        findPreSummaries: vi.fn().mockResolvedValue([]),
        encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
      };
      const { service } = buildDeps(buildHttpMock(), {
        config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '1000' },
        contextItemRepository: repo,
        secretsService,
      });
      service.start({ consultationId: CID, tenantId: TENANT });

      // Cross the window → first durable write = create; must be preceded by encryption.
      vi.advanceTimersByTime(1200);
      service.ingestSegment(CID, { text: 'a', isFinal: true, segmentId: 's1' });
      await service.flush(CID);
      expect(repo.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [createEntityArg, createSecretsArg] = repo.encryptContentIntoEntity.mock.calls[0];
      expect(createEntityArg.content).toBeTruthy();
      expect(createSecretsArg).toBe(secretsService);
      const encOrder1 = repo.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = repo.create.mock.invocationCallOrder[0];
      expect(encOrder1).toBeLessThan(createOrder);

      // Cross again → upsert the same row (update); must also be preceded by encryption.
      vi.advanceTimersByTime(1200);
      service.ingestSegment(CID, { text: 'b', isFinal: true, segmentId: 's2' });
      await service.flush(CID);
      expect(repo.encryptContentIntoEntity).toHaveBeenCalledTimes(2);
      const encOrder2 = repo.encryptContentIntoEntity.mock.invocationCallOrder[1];
      const updateOrder = repo.update.mock.invocationCallOrder[0];
      expect(encOrder2).toBeLessThan(updateOrder);

      // Final-on-stop also encrypts before its update.
      await service.stop(CID, { persistSnapshot: true });
      expect(repo.encryptContentIntoEntity).toHaveBeenCalledTimes(3);
    });
  });

  // ------------------------------------------------------------------
  // P2: kill-switch + metrics
  // ------------------------------------------------------------------
  describe('safety rails + observability', () => {
    it('does not start a watcher session when LIVE_DOC_ENABLED is false (kill-switch)', () => {
      const { service } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_ENABLED: 'false' } });
      service.start({ consultationId: CID, tenantId: TENANT });
      expect(service.isActive(CID)).toBe(false);
    });

    it('emits a structured flush metrics log (latency + counts, no transcript text)', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      const flushLog = logSpy.mock.calls.find((c) => (c[0] as { message?: string })?.message === 'Live summary flush');
      expect(flushLog).toBeDefined();
      const fields = flushLog![0] as Record<string, unknown>;
      expect(fields).toHaveProperty('smrLatencyMs');
      expect(fields).toHaveProperty('flushCount');
      expect(JSON.stringify(fields)).not.toContain('Patient on amlodipine');
    });
  });

  // ------------------------------------------------------------------
  // B1: per-session stats published to Redis for the admin
  // live console — `live-doc:stats:{cid}` snapshot + `live-doc:active:{tenant}` set.
  // ------------------------------------------------------------------
  describe('admin live stats publish/clear', () => {
    const STATS_KEY = `live-doc:stats:${CID}`;
    const ACTIVE_SET = `live-doc:active:${TENANT}`;

    it('writes a PHI-safe stats snapshot + adds the id to the tenant active set on each flush', async () => {
      const { service, cacheService } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT, sessionId: 'stt-1' });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 'seg-9' });

      await service.flush(CID);

      const statsCall = cacheService.setex.mock.calls.find((c: unknown[]) => c[0] === STATS_KEY);
      expect(statsCall).toBeDefined();
      const snapshot = JSON.parse(statsCall![2] as string);
      expect(snapshot.consultationId).toBe(CID);
      expect(snapshot.tenantId).toBe(TENANT);
      expect(snapshot.sessionId).toBe('stt-1');
      expect(snapshot.flushCount).toBe(1);
      expect(snapshot).toHaveProperty('smrLatencyMs');
      expect(snapshot).toHaveProperty('entityCount');
      expect(typeof snapshot.lastUpdatedAt).toBe('string');
      // PHI-safe: no transcript / summary text in the snapshot.
      expect(JSON.stringify(snapshot)).not.toContain('Patient on amlodipine');
      expect(JSON.stringify(snapshot)).not.toContain('Pt on amlodipine for HTN.');

      expect(cacheService.sadd).toHaveBeenCalledWith(ACTIVE_SET, CID);
    });

    it('clears the stats snapshot + removes the id from the active set on stop', async () => {
      const { service, cacheService } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      await service.stop(CID);

      expect(cacheService.del).toHaveBeenCalledWith(STATS_KEY);
      expect(cacheService.srem).toHaveBeenCalledWith(ACTIVE_SET, CID);
    });

    it('getActiveSessions reads the active set + per-session stats, tenant-isolated', async () => {
      const { service, cacheService } = buildDeps();
      cacheService.smembers.mockResolvedValue([CID]);
      cacheService.get.mockImplementation((key: string) =>
        key === STATS_KEY
          ? Promise.resolve(JSON.stringify({ consultationId: CID, tenantId: TENANT, flushCount: 4, lastUpdatedAt: 'now' }))
          : Promise.resolve(null),
      );

      const result = await service.getActiveSessions(TENANT);

      expect(cacheService.smembers).toHaveBeenCalledWith(ACTIVE_SET);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({ consultationId: CID, tenantId: TENANT, flushCount: 4 });
    });

    it('getActiveSessions self-heals an orphaned set member whose stats expired', async () => {
      const { service, cacheService } = buildDeps();
      cacheService.smembers.mockResolvedValue([CID]);
      cacheService.get.mockResolvedValue(null); // stats key expired / process crashed

      const result = await service.getActiveSessions(TENANT);

      expect(result.total).toBe(0);
      expect(cacheService.srem).toHaveBeenCalledWith(ACTIVE_SET, CID);
    });

    it('getSessionStats returns null for a cross-tenant stats snapshot', async () => {
      const { service, cacheService } = buildDeps();
      cacheService.get.mockResolvedValue(JSON.stringify({ consultationId: CID, tenantId: 'other-tenant', flushCount: 1 }));

      const result = await service.getSessionStats(TENANT, CID);
      expect(result).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // B3: runtime kill-switch — env default + Redis override.
  // ------------------------------------------------------------------
  describe('runtime kill-switch', () => {
    const CONFIG_KEY = 'live-doc:config:enabled';

    it('getEngineConfig reports the env default when no Redis override is set', async () => {
      const { service, cacheService } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_ENABLED: 'true' } });
      cacheService.get.mockResolvedValue(null);

      const config = await service.getEngineConfig();
      expect(config).toMatchObject({ enabled: true, envDefault: true, source: 'env-default' });
    });

    it('setEngineEnabled(false) persists a Redis override that disables NEW sessions at runtime', async () => {
      const { service, cacheService } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_ENABLED: 'true' } });

      const result = await service.setEngineEnabled(false, { userId: 'admin-1', reason: 'incident' });

      expect(result).toMatchObject({ enabled: false, envDefault: true, source: 'redis-override', updatedBy: 'admin-1' });
      const writeCall = cacheService.set.mock.calls.find((c: unknown[]) => c[0] === CONFIG_KEY);
      expect(writeCall).toBeDefined();
      expect(JSON.parse(writeCall![1] as string)).toMatchObject({ enabled: false, updatedBy: 'admin-1' });

      // Runtime effect: a new session must NOT start while the override is OFF.
      service.start({ consultationId: CID, tenantId: TENANT });
      expect(service.isActive(CID)).toBe(false);
    });

    it('setEngineEnabled(true) re-enables sessions even when the env default is false', async () => {
      const { service } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_ENABLED: 'false' } });

      // Env default OFF → start is a no-op.
      service.start({ consultationId: CID, tenantId: TENANT });
      expect(service.isActive(CID)).toBe(false);

      await service.setEngineEnabled(true, { userId: 'admin-1' });

      service.start({ consultationId: CID, tenantId: TENANT });
      expect(service.isActive(CID)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // GAP #3d: live drop-out of a soft-deleted context note.
  // contextNotes are re-keyed by contextItemId so a removed note can be
  // dropped precisely from the in-flight running summary.
  // ------------------------------------------------------------------
  describe('context drop-out', () => {
    /** Pull the prompt sent to SMR `/generate` on the most recent flush. */
    const lastSmrPrompt = (httpMock: ReturnType<typeof buildHttpMock>): string => {
      const calls = httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate'));
      return calls.length ? String((calls[calls.length - 1][1] as { prompt?: string }).prompt ?? '') : '';
    };

    it('threads an added context note into the SMR prompt unchanged (add-only, no regression)', async () => {
      const { service, httpMock } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-note-1',
        contextType: 'CASE_NOTE',
        contentPreview: 'Patient reports chest pain',
      });

      await service.flush(CID, { force: true });

      // The add path must produce the SAME notes block as before the re-key:
      // the prompt carries the note text verbatim under the clinician-notes label.
      expect(lastSmrPrompt(httpMock)).toContain('Clinician notes / labs:\nPatient reports chest pain');
    });

    it('drops a removed note from the SMR prompt on the next flush, keeping the others', async () => {
      const { service, httpMock } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-keep',
        contextType: 'CASE_NOTE',
        contentPreview: 'Allergic to penicillin',
      });
      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-remove',
        contextType: 'CASE_NOTE',
        contentPreview: 'Patient reports chest pain',
      });

      await service.flush(CID, { force: true });
      const before = lastSmrPrompt(httpMock);
      expect(before).toContain('Allergic to penicillin');
      expect(before).toContain('Patient reports chest pain');

      // Soft-delete fan-out for the second note (ConsultationPipelineEvent.ContextRemoved).
      service.handleContextRemoved({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-remove',
      });

      await service.flush(CID, { force: true });
      const after = lastSmrPrompt(httpMock);
      expect(after).toContain('Allergic to penicillin');
      expect(after).not.toContain('Patient reports chest pain');
    });

    it('handleContextRemoved is a no-op for an untracked session / note id', () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      expect(() =>
        service.handleContextRemoved({
          consultationId: 'unknown-consultation',
          tenantId: TENANT,
          timestamp: new Date().toISOString(),
          contextItemId: 'whatever',
        }),
      ).not.toThrow();

      expect(() =>
        service.handleContextRemoved({
          consultationId: CID,
          tenantId: TENANT,
          timestamp: new Date().toISOString(),
          contextItemId: 'never-added',
        }),
      ).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // OCR enrichment re-emits ContextAdded for the SAME
  // contextItemId once it has extracted text. The add path UPSERTS by
  // contextItemId so the attachment yields exactly ONE running-summary
  // note that is updated in place — no harmless-but-confusing duplicate.
  // ------------------------------------------------------------------
  describe('context note upsert on OCR re-emit', () => {
    type TrackedNote = { contextItemId: string; text: string };
    /** Peek at the in-flight session's keyed context notes (internal state). */
    const trackedNotes = (service: LiveDocumentationService, consultationId: string): TrackedNote[] =>
      (service as unknown as { sessions: Map<string, { contextNotes: TrackedNote[] }> }).sessions.get(consultationId)!.contextNotes;

    /** Pull the prompt sent to SMR `/generate` on the most recent flush. */
    const lastSmrPrompt = (httpMock: ReturnType<typeof buildHttpMock>): string => {
      const calls = httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate'));
      return calls.length ? String((calls[calls.length - 1][1] as { prompt?: string }).prompt ?? '') : '';
    };

    it('updates the existing note in place when ContextAdded re-fires for the same contextItemId (no duplicate)', async () => {
      const { service, httpMock } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      // 1) Initial attachment add — scanned lab with no client-side text layer, so
      // the live preview is just the filename-label placeholder.
      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-attach-1',
        contextType: 'ATTACHMENT',
        subType: 'LAB_RESULT',
        contentPreview: 'lab-scan.pdf (no text layer)',
      });

      // 2) OCR enrichment re-emits ContextAdded for the SAME contextItemId, now
      // carrying the extracted text.
      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-attach-1',
        contextType: 'ATTACHMENT',
        subType: 'LAB_RESULT',
        contentPreview: 'Hemoglobin 13.5 g/dL; WBC 6.2',
      });

      // Exactly ONE note for that attachment, reflecting the enriched content.
      const notes = trackedNotes(service, CID);
      expect(notes).toHaveLength(1);
      expect(notes[0].contextItemId).toBe('ctx-attach-1');
      expect(notes[0].text).toContain('Hemoglobin 13.5 g/dL; WBC 6.2');
      expect(notes[0].text).not.toContain('lab-scan.pdf (no text layer)');

      // The enriched (not the stale placeholder) content reaches the SMR prompt once.
      await service.flush(CID, { force: true });
      const prompt = lastSmrPrompt(httpMock);
      expect(prompt).toContain('Hemoglobin 13.5 g/dL; WBC 6.2');
      expect(prompt).not.toContain('lab-scan.pdf (no text layer)');
    });

    it('still appends a new note for a distinct contextItemId (non-duplicate path unchanged)', () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-note-a',
        contextType: 'CASE_NOTE',
        contentPreview: 'Allergic to penicillin',
      });
      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-note-b',
        contextType: 'CASE_NOTE',
        contentPreview: 'Reports chest pain',
      });

      const notes = trackedNotes(service, CID);
      expect(notes).toHaveLength(2);
      expect(notes.map((n) => n.contextItemId)).toEqual(['ctx-note-a', 'ctx-note-b']);
    });
  });
});
