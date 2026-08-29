/**
 * LiveDocumentationService Unit Tests
 *
 * Covers the net-new realtime watcher behaviour:
 *   - debounce: flush at the segment threshold (~3 final segments)
 *   - debounce: flush on the idle timer (~5s) for a trailing segment
 *   - aggregate/payload shaping: TEXT running summary + NLP entities → SSE payload
 *   - TEXT/NLP fault tolerance (a down service keeps the prior value)
 *   - SSE relay: stored snapshot emitted first, then channel messages relayed
 *   - interim (non-final) segments are ignored
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Subject, finalize } from 'rxjs';
import { LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-001';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:live-summary:${CID}`;

/**
 * `findLiveSnapshotRow` now delegates to the repository's
 * `findLatestPreSummaryWithDecryptedContent` (find + subType-filter +
 * newest-wins reduce) instead of hand-rolling it. Fake repos in this file only
 * implement `findPreSummaries`, so this helper adds the delegate on top,
 * DELEGATING through the SAME `findPreSummaries` mock every existing test
 * already configures — no test's `mockResolvedValue`/row-pushing setup needs
 * to change.
 */
function withFindLatestPreSummaryWithDecryptedContent<T extends { findPreSummaries: (id: string) => Promise<any[]> }>(
  repo: T,
): T & { findLatestPreSummaryWithDecryptedContent: ReturnType<typeof vi.fn> } {
  const augmented = repo as T & { findLatestPreSummaryWithDecryptedContent: ReturnType<typeof vi.fn> };
  augmented.findLatestPreSummaryWithDecryptedContent = vi.fn(async (consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
    const preSummaries = await repo.findPreSummaries(consultationId);
    const candidates = options?.subType
      ? preSummaries.filter((p: any) => (p.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
      : preSummaries;
    if (candidates.length === 0) return { entity: null, plaintext: null };
    const entity = candidates.reduce((a: any, b: any) => (a.createdAt >= b.createdAt ? a : b));
    return { entity, plaintext: entity.content ?? null };
  });
  return augmented;
}

/**
 * A faithful fake of `RedisSubscriberService`'s refcounted, per-channel-Subject
 * contract (mirrors the real `subscribeToChannel`/`decrementAndCleanup`):
 *   - callers SHARE one Subject per channel,
 *   - each subscription increments a refcount and `finalize`s a decrement,
 *   - the underlying channel is torn down (Subject completed) ONLY when the
 *     last observer leaves.
 * This is exactly the behaviour F-04 depends on — a plain `vi.fn()` returning a
 * bare Subject cannot exercise the shared-teardown race.
 */
function makeRefcountedSubscriber() {
  const subjects = new Map<string, Subject<string>>();
  const refCounts = new Map<string, number>();
  const unsubscribeFromChannel = vi.fn((channel: string) => {
    const subject = subjects.get(channel);
    if (subject) {
      subject.complete();
      subjects.delete(channel);
      refCounts.delete(channel);
    }
  });
  const subscribeToChannel = vi.fn(async (channel: string) => {
    if (!subjects.has(channel)) {
      subjects.set(channel, new Subject<string>());
      refCounts.set(channel, 0);
    }
    refCounts.set(channel, (refCounts.get(channel) ?? 0) + 1);
    const subject = subjects.get(channel)!;
    return subject.asObservable().pipe(
      finalize(() => {
        const next = Math.max(0, (refCounts.get(channel) ?? 0) - 1);
        if (next === 0) unsubscribeFromChannel(channel);
        else refCounts.set(channel, next);
      }),
    );
  });
  return {
    subscribeToChannel,
    unsubscribeFromChannel,
    /** Publish onto a channel's shared Subject (what `safePublish` does at runtime). */
    publish: (channel: string, msg: string) => subjects.get(channel)?.next(msg),
    /** True while the channel still has a live shared Subject. */
    isChannelLive: (channel: string) => subjects.has(channel),
  };
}

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
          return Promise.resolve({
            data: { entities: [{ entity_type: 'MEDICATION', text: 'amlodipine', confidence: 0.92, position: { start: 3, end: 13 } }] },
          });
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
  // Nlp.ner model-injection resolver deps. Both default to WORKING
  // doubles: model selection is fail-CLOSED, so a fixture reaching the NER hop
  // without them takes a 503 rather than posting without `model_name`. Pass an
  // explicit `undefined` (the key present) to exercise a refusal.
  aiTaskDefaultService?: any;
  cls?: any;
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
  // Wrapped so EVERY contextItemRepository fixture used through
  // this factory (default or opts-supplied) gets the delegate that
  // `findLiveSnapshotRow` now calls, regardless of which describe block built it.
  const contextItemRepository = withFindLatestPreSummaryWithDecryptedContent(
    opts.contextItemRepository ?? {
      create: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
      update: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
      findTranscripts: vi.fn().mockResolvedValue([]),
      // Deterministic durable-snapshot dedup hooks (C5-06 / I-1) — default: no rows.
      findLatestPreSummary: vi.fn().mockResolvedValue(null),
      findPreSummaries: vi.fn().mockResolvedValue([]),
    },
  );
  const config = opts.config ?? {};
  const configService = { get: vi.fn().mockImplementation((key: string) => config[key]) };
  // Live-doc resolves provider+model via the HarnessPolicy cascade
  // (not env). Default stub resolves successfully so TEXT-path tests still flow.
  const harnessPolicyService = opts.harnessPolicyService ?? {
    resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'live-medgemma' }),
  };

  const secretsService = opts.secretsService;
  // `in` rather than `??` so an explicit `undefined` still means "absent" —
  // that is how the fail-closed refusal cases are set up.
  const aiTaskDefaultService =
    'aiTaskDefaultService' in opts
      ? opts.aiTaskDefaultService
      : { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) };
  const cls = 'cls' in opts ? opts.cls : { run: vi.fn((callback: () => unknown) => callback()), set: vi.fn(), get: vi.fn() };

  const service = new LiveDocumentationService(
    httpMock as any,
    configService as any,
    cacheService as any,
    redisSubscriber as any,
    audioBridge as any,
    contextItemRepository as any,
    harnessPolicyService as any,
    secretsService as any,
    undefined, // trajectoryService
    undefined, // effectiveSettings
    aiTaskDefaultService as any,
    cls as any,
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
    it('builds the SSE payload from TEXT summary + NLP entities and publishes it', async () => {
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

    it('tolerates an NLP outage and keeps the TEXT summary', async () => {
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
  // TASK-703: `textFailed` computed internally on a failed TEXT call but never
  // attached to the published `LiveSummaryEventDto` — a first-flush failure
  // published an empty note indistinguishable from "nothing said yet", and a
  // later-flush failure froze stale content under a fresh `updatedAt` with no
  // marker. The published payload must carry `textFailed: true` in both cases.
  // ------------------------------------------------------------------
  describe('textFailed degradation marker (TASK-703)', () => {
    it('marks a first-flush TEXT failure with textFailed: true (no prior content to freeze)', async () => {
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) return Promise.reject(new Error('TEXT down'));
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient reports chest pain.', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      expect(payload).not.toBeNull();
      expect(payload!.textFailed).toBe(true);
      expect(payload!.runningSummary).toBe('');
      expect(payload!.sections).toEqual([]);
    });

    it('marks a later-flush TEXT failure with textFailed: true while freezing the prior content', async () => {
      let generateCalls = 0;
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              generateCalls += 1;
              if (generateCalls === 1) return Promise.resolve({ data: { summary: 'Pt on amlodipine for HTN.' } });
              return Promise.reject(new Error('TEXT down'));
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient on amlodipine.', isFinal: true, segmentId: 's1' });

      const firstPayload = await service.flush(CID);
      expect(firstPayload!.runningSummary).toBe('Pt on amlodipine for HTN.');
      expect(firstPayload!.textFailed).toBeUndefined();

      service.ingestSegment(CID, { text: 'Follow-up note.', isFinal: true, segmentId: 's2' });
      const secondPayload = await service.flush(CID, { force: true });

      expect(secondPayload).not.toBeNull();
      expect(secondPayload!.textFailed).toBe(true);
      // Frozen: retains the last-good content rather than being wiped/blanked.
      expect(secondPayload!.runningSummary).toBe('Pt on amlodipine for HTN.');
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

  // ------------------------------------------------------------------
  // Nlp.ner AiTaskDefault model injection (fail-CLOSED)
  // ------------------------------------------------------------------
  describe('nlp.ner model injection', () => {
    function makeCls() {
      return { run: vi.fn((callback: () => unknown) => callback()), set: vi.fn(), get: vi.fn() };
    }

    it('injects the effective nlp.ner model_name when the AiTaskDefault service resolves one', async () => {
      const aiTaskDefaultService = {
        getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }),
      };
      const cls = makeCls();
      const { service, httpMock } = buildDeps(buildHttpMock(), { aiTaskDefaultService, cls });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/classify/tokens'))!;
      expect((nlpCall[1] as { model_name?: string }).model_name).toBe('blaze999/Medical-NER');
    });

    it('never posts to /classify/tokens (fail-closed) when AiTaskDefault resolution fails', async () => {
      const aiTaskDefaultService = {
        getEffective: vi.fn().mockRejectedValue(new Error('registry unavailable')),
      };
      const cls = makeCls();
      const { service, httpMock } = buildDeps(buildHttpMock(), { aiTaskDefaultService, cls });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      // NEVER posted without `model_name`: NLP now REQUIRES it and answers 503
      // without it, so fail-open would only move the same failure one hop out.
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/classify/tokens'));
      expect(nlpCall).toBeUndefined();
    });

    it('never posts to /classify/tokens when CLS is not wired — the SYSTEM pin cannot be established', async () => {
      // An absent CLS scope is a refusal like any other: without a scope to pin,
      // the SYSTEM-only read would resolve under the ambient tenant instead.
      const { service, httpMock } = buildDeps(buildHttpMock(), { aiTaskDefaultService: undefined, cls: undefined });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/classify/tokens'));
      expect(nlpCall).toBeUndefined();
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
                data: {
                  entities: [
                    { entity_type: 'MEDICATION', text: 'amlodipine', confidence: 0.9, position: { start, end: start + 'amlodipine'.length } },
                  ],
                },
              });
            }
            if (url.includes('/generate')) return Promise.resolve({ data: { summary: SOAP } });
            return Promise.resolve({ data: {} });
          }),
        },
      };
    }

    it('emits the four ordered SOAP sections parsed from the TEXT output', async () => {
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

      // NER is handed the raw transcript delta (the text that feeds TEXT), NOT the note.
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'))!;
      expect(nlpCall[1].text).toBe('Patient has chest pain');
      expect(nlpCall[1].text).not.toBe(payload!.runningSummary);

      // The published entity is grounded, so its offsets resolve to the exact span within runningSummary.
      const entity = payload!.entities[0];
      expect(payload!.runningSummary.slice(entity.start!, entity.end!)).toBe('amlodipine');
    });

    it('falls back to a single "Running Summary" section for unstructured TEXT output', async () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);
      expect(payload!.sections).toEqual([{ title: 'Running Summary', content: 'Pt on amlodipine for HTN.' }]);
    });
  });

  // ------------------------------------------------------------------
  // AD-1 generation stats on the live-summary SSE payload.
  // The TEXT /generate response now carries a `stats` block; each flush must
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

    // The live plane routes through the `text.live`
    // AiTaskDefault key (not `text.finalize`); surface that provenance on the
    // flush's stats so the console/ stat cards can show WHICH tier
    // (and therefore which admin-managed model) served this flush.
    it('stamps metadata.stats.task_key as text.live (provenance)', async () => {
      const { service } = buildDeps(statsHttpMock(POPULATED_STATS));
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      expect(payload!.metadata?.stats?.task_key).toBe('text.live');
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

    it('degrades cleanly when TEXT omits stats — no metadata.stats, feed still publishes', async () => {
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
    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    it('emits the stored snapshot first then relays channel messages', async () => {
      const redisSubscriber = makeRefcountedSubscriber();
      const { service, cacheService } = buildDeps(buildHttpMock(), { redisSubscriber });
      const snapshot = JSON.stringify({ consultationId: CID, runningSummary: 'snap', sections: [], entities: [], updatedAt: 'now' });
      cacheService.get.mockResolvedValue(snapshot);

      const events: Array<{ data: string }> = [];
      const sub = service.subscribeToLiveSummary(CID).subscribe((e: any) => events.push(e));

      await tick();
      expect(events[0].data).toBe(snapshot);

      // No `updatedAt` on this event → never de-duped against the snapshot.
      redisSubscriber.publish(CHANNEL, JSON.stringify({ consultationId: CID, runningSummary: 'updated' }));
      await tick();
      expect(events[1].data).toContain('updated');

      // F-04: teardown must NOT call the direct (shared-Subject-completing)
      // `unsubscribeFromChannel` — it must flow through the refcount, which only
      // tears the channel down because this is the last (only) viewer.
      sub.unsubscribe();
      await tick();
      expect(redisSubscriber.isChannelLive(CHANNEL)).toBe(false);
    });

    it('F-04: one viewer disconnecting does NOT complete a co-viewer’s stream', async () => {
      const redisSubscriber = makeRefcountedSubscriber();
      const { service, cacheService } = buildDeps(buildHttpMock(), { redisSubscriber });
      cacheService.get.mockResolvedValue(null);

      const aEvents: Array<{ data: string }> = [];
      let aCompleted = false;
      const bEvents: Array<{ data: string }> = [];
      let bCompleted = false;

      const subA = service.subscribeToLiveSummary(CID).subscribe({ next: (e: any) => aEvents.push(e), complete: () => (aCompleted = true) });
      const subB = service.subscribeToLiveSummary(CID).subscribe({ next: (e: any) => bEvents.push(e), complete: () => (bCompleted = true) });
      await tick();

      // First viewer leaves.
      subA.unsubscribe();
      await tick();

      // The shared channel must still be live (viewer B holds a ref) and B must
      // still receive events — the old direct-unsubscribe force-completed it.
      expect(aCompleted).toBe(false); // A's own teardown, not a completion
      expect(bCompleted).toBe(false);
      expect(redisSubscriber.isChannelLive(CHANNEL)).toBe(true);

      redisSubscriber.publish(CHANNEL, JSON.stringify({ consultationId: CID, runningSummary: 'still-flowing', updatedAt: '2026-07-24T00:00:01Z' }));
      await tick();
      expect(bEvents.some((e) => e.data.includes('still-flowing'))).toBe(true);

      subB.unsubscribe();
      await tick();
      expect(redisSubscriber.isChannelLive(CHANNEL)).toBe(false);
    });

    it('F-05: an event published between subscribe and snapshot-read still reaches the viewer', async () => {
      const redisSubscriber = makeRefcountedSubscriber();
      const { service, cacheService } = buildDeps(buildHttpMock(), { redisSubscriber });

      // Delay the snapshot read so we can publish DURING the read window. With
      // the old snapshot-before-subscribe order this event would be lost.
      let releaseSnapshot!: () => void;
      cacheService.get.mockReturnValue(
        new Promise((resolve) => {
          releaseSnapshot = () => resolve(null);
        }),
      );

      const events: Array<{ data: string }> = [];
      const sub = service.subscribeToLiveSummary(CID).subscribe((e: any) => events.push(e));

      // Let the subscribe-first path attach to the channel (snapshot still pending).
      await tick();
      expect(redisSubscriber.subscribeToChannel).toHaveBeenCalledWith(CHANNEL);

      // Publish while the snapshot read is still in flight — buffered by ReplaySubject.
      redisSubscriber.publish(CHANNEL, JSON.stringify({ consultationId: CID, runningSummary: 'raced-in', updatedAt: '2026-07-24T00:00:02Z' }));

      // Now let the snapshot read resolve (null → nothing to emit).
      releaseSnapshot();
      await tick();

      expect(events.some((e) => e.data.includes('raced-in'))).toBe(true);

      sub.unsubscribe();
    });

    it('F-05: a terminal `closed` published during the snapshot window still completes the stream', async () => {
      const redisSubscriber = makeRefcountedSubscriber();
      const { service, cacheService } = buildDeps(buildHttpMock(), { redisSubscriber });

      let releaseSnapshot!: () => void;
      cacheService.get.mockReturnValue(new Promise((resolve) => (releaseSnapshot = () => resolve(null))));

      let completed = false;
      const sub = service.subscribeToLiveSummary(CID).subscribe({ next: () => {}, complete: () => (completed = true) });
      await tick();

      redisSubscriber.publish(CHANNEL, JSON.stringify({ consultationId: CID, closed: true, updatedAt: '2026-07-24T00:00:03Z' }));
      releaseSnapshot();
      await tick();

      expect(completed).toBe(true);
      sub.unsubscribe();
    });
  });

  // ------------------------------------------------------------------
  // P0-A: overlapping generations, abort, throttle
  // ------------------------------------------------------------------
  describe('overlapping flushes', () => {
    it('drops a stale in-flight generation when a newer flush supersedes it (no out-of-order publish)', async () => {
      const deferred = makeDeferred();
      let textCalls = 0;
      const httpMock = {
        axiosRef: {
          post: vi.fn().mockImplementation((url: string) => {
            if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [] } });
            if (url.includes('/generate')) {
              textCalls += 1;
              if (textCalls === 1) return deferred.promise.then(() => ({ data: { summary: 'STALE first' } }));
              return Promise.resolve({ data: { summary: 'FRESH second' } });
            }
            return Promise.resolve({ data: {} });
          }),
        },
      };
      const { service, cacheService } = buildDeps(httpMock, { config: { LIVE_DOC_MIN_INTERVAL_MS: '0' } });
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'first', isFinal: true, segmentId: 's1' });
      const p1 = service.flush(CID); // generation 1 — TEXT hangs
      service.ingestSegment(CID, { text: 'second', isFinal: true, segmentId: 's2' });
      const p2 = service.flush(CID); // generation 2 — supersedes; TEXT resolves immediately
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

    it('throttles live TEXT calls to at most one per LIVE_DOC_MIN_INTERVAL_MS', async () => {
      vi.useFakeTimers();
      const { service, httpMock } = buildDeps(buildHttpMock(), { config: { LIVE_DOC_MIN_INTERVAL_MS: '4000' } });
      const generateCalls = () => httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate')).length;

      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'a', isFinal: true, segmentId: 's1' });
      await service.flush(CID);
      expect(generateCalls()).toBe(1);

      // A 2nd flush inside the window must be throttled (scheduled, no TEXT call yet).
      service.ingestSegment(CID, { text: 'b', isFinal: true, segmentId: 's2' });
      await service.flush(CID);
      expect(generateCalls()).toBe(1);

      // Once the window elapses, the scheduled trailing flush fires.
      await vi.advanceTimersByTimeAsync(4000);
      expect(generateCalls()).toBe(2);
    });

    it('passes an abort signal to the TEXT and NLP calls so in-flight work can be cancelled', async () => {
      const { service, httpMock } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      const textCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/generate'))!;
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/classify/tokens'))!;
      expect((textCall[2] as { signal?: unknown }).signal).toBeDefined();
      expect((nlpCall[2] as { signal?: unknown }).signal).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // P0-B: incremental prompt + bounded TEXT params
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

    it('sets bounded live TEXT params (max_tokens, lower timeout) and resolves provider/model via policy', async () => {
      const harnessPolicyService = {
        resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'openai', model: 'fast-model' }),
      };
      const { service, httpMock } = buildDeps(buildHttpMock(), {
        config: {
          LIVE_DOC_TEXT_MAX_TOKENS: '1500',
          LIVE_DOC_TEXT_TIMEOUT_MS: '20000',
        },
        harnessPolicyService,
      });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

      // Provider+model come from the policy cascade (keyed by the session tenant),
      // not LIVE_DOC_TEXT_PROVIDER/MODEL env. The live flush must ask
      // for the LIVE tier ('text.live'), not the default finalize tier.
      // TASK-816: `undefined` is the third arg because no graph NODE made this call (legacy
      // flush), so no `llmBinding` applies and the tenant `text.live` AiTaskDefault resolves
      // exactly as it always did.
      expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledWith(TENANT, 'live', undefined);
      const textCall = httpMock.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/generate'))!;
      const body = textCall[1] as { max_tokens?: number; provider?: string; model?: string; response_format?: { type?: string } };
      const config = textCall[2] as { timeout?: number };
      expect(body.max_tokens).toBe(1500);
      expect(body.provider).toBe('openai');
      expect(body.model).toBe('fast-model');
      expect(body.response_format?.type).toBe('json_schema');
      expect(config.timeout).toBe(20000);
    });
  });

  // ------------------------------------------------------------------
  // F-28: defensive caps on the append-only `session.transcriptParts` buffer.
  // A pathological/runaway session (mic left open, no `stop()`) would otherwise
  // grow it unbounded. Windowing/truncation only bounds what's SENT per flush
  // (`bounded transcript cost` above), not the underlying array's growth.
  // ------------------------------------------------------------------
  describe('transcriptParts buffer caps (F-28)', () => {
    // High segment threshold + zero min-interval so ingest never auto-flushes —
    // the loop just needs to exercise `ingestSegment`'s push/cap logic directly.
    function buildUncappedService() {
      return buildDeps(buildHttpMock(), {
        config: { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_SEGMENT_THRESHOLD: '1000000' },
      });
    }

    it('warns once when transcriptParts exceeds 10,000 finals', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const { service } = buildUncappedService();
      service.start({ consultationId: CID, tenantId: TENANT });

      for (let i = 0; i < 10_005; i++) {
        service.ingestSegment(CID, { text: `seg ${i}`, isFinal: true, segmentId: `s${i}` });
      }

      const capWarn = warnSpy.mock.calls.filter((c) =>
        String((c[0] as { message?: string })?.message ?? '')
          .toLowerCase()
          .includes('transcriptparts'),
      );
      expect(capWarn).toHaveLength(1);
    });

    it('does not warn below the 10,000 threshold', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const { service } = buildUncappedService();
      service.start({ consultationId: CID, tenantId: TENANT });

      for (let i = 0; i < 500; i++) {
        service.ingestSegment(CID, { text: `seg ${i}`, isFinal: true, segmentId: `s${i}` });
      }

      const capWarn = warnSpy.mock.calls.filter((c) =>
        String((c[0] as { message?: string })?.message ?? '')
          .toLowerCase()
          .includes('transcriptparts'),
      );
      expect(capWarn).toHaveLength(0);
    });

    it('hard-caps transcriptParts at 50,000 and logs an error once', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const { service } = buildUncappedService();
      service.start({ consultationId: CID, tenantId: TENANT });

      for (let i = 0; i < 50_010; i++) {
        service.ingestSegment(CID, { text: `seg ${i}`, isFinal: true, segmentId: `s${i}` });
      }

      const session = (service as unknown as { sessions: Map<string, { transcriptParts: string[] }> }).sessions.get(CID)!;
      expect(session.transcriptParts.length).toBe(50_000);

      const capError = errorSpy.mock.calls.filter((c) =>
        String((c[0] as { message?: string })?.message ?? '')
          .toLowerCase()
          .includes('transcriptparts'),
      );
      expect(capError).toHaveLength(1);
    });

    it('keeps windowing/flush behaviour unaffected below the cap', async () => {
      const { service } = buildUncappedService();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.ingestSegment(CID, { text: 'Patient on amlodipine', isFinal: true, segmentId: 's1' });
      const payload = await service.flush(CID);

      expect(payload).not.toBeNull();
      expect(payload!.runningSummary).toBe('Pt on amlodipine for HTN.');
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

    /** An httpMock that records every TEXT `/generate` prompt. */
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

      // The early clinical content must have reached TEXT in SOME flush (kept as the
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

      const truncWarn = warnSpy.mock.calls.find((c) =>
        String((c[0] as { message?: string })?.message ?? '')
          .toLowerCase()
          .includes('truncat'),
      );
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
    it('parses a SOAP JSON TEXT response into the four ordered sections (no regex dependency)', async () => {
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
      expect(publishes.some(([ch, p]: [string, { closed?: boolean }]) => ch === 'consultation:live-summary:other-cid' && p.closed === true)).toBe(
        true,
      );
      // stop signal on the control channel (so an owner on another instance tears down)
      expect(
        publishes.some(([ch, p]: [string, { type?: string }]) => ch === 'consultation:live-summary:other-cid:control' && p.type === 'stop'),
      ).toBe(true);
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
  // second instance can neither run a duplicate watcher (duplicate TEXT spend)
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

    it('acquires the owner lock with SET NX so a second instance bails out of start() (no duplicate TEXT call)', async () => {
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
      await b.service.flush(CID); // null — no session, no TEXT

      // One consultation → exactly ONE TEXT /generate call, not two.
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

      // The most-recent content (the tail) reached TEXT — not dropped by a single
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
      expect(fields).toHaveProperty('textLatencyMs');
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
      expect(snapshot).toHaveProperty('textLatencyMs');
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
    /** Pull the prompt sent to TEXT `/generate` on the most recent flush. */
    const lastTextPrompt = (httpMock: ReturnType<typeof buildHttpMock>): string => {
      const calls = httpMock.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate'));
      return calls.length ? String((calls[calls.length - 1][1] as { prompt?: string }).prompt ?? '') : '';
    };

    it('threads an added context note into the TEXT prompt unchanged (add-only, no regression)', async () => {
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
      expect(lastTextPrompt(httpMock)).toContain('Clinician notes / labs:\nPatient reports chest pain');
    });

    it('drops a removed note from the TEXT prompt on the next flush, keeping the others', async () => {
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
      const before = lastTextPrompt(httpMock);
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
      const after = lastTextPrompt(httpMock);
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
  // The ContextAdded gate widened to also emit for TRANSCRIPT and
  // STRUCTURED (loop event plane). LiveDocumentationService was written for
  // WORKNOTE/CASE_NOTE/ATTACHMENT only — it must ignore everything else so
  // the widening does not change what folds into the running summary.
  // ------------------------------------------------------------------
  describe('ContextAdded kind filter (regression — kind widening)', () => {
    type TrackedNote = { contextItemId: string; text: string };
    const trackedNotes = (service: LiveDocumentationService, consultationId: string): TrackedNote[] =>
      (service as unknown as { sessions: Map<string, { contextNotes: TrackedNote[] }> }).sessions.get(consultationId)!.contextNotes;

    it('ignores a TRANSCRIPT ContextAdded event (no note tracked, no flush scheduled)', () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-transcript-1',
        contextType: 'TRANSCRIPT',
        contentPreview: 'Patient reports chest pain.',
      });

      expect(trackedNotes(service, CID)).toHaveLength(0);
    });

    it('ignores a STRUCTURED ContextAdded event (no note tracked)', () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-structured-1',
        contextType: 'STRUCTURED',
        contentPreview: '{"bp":"120/80"}',
      });

      expect(trackedNotes(service, CID)).toHaveLength(0);
    });

    it('still tracks the pre-existing WORKNOTE/CASE_NOTE/ATTACHMENT kinds unchanged', () => {
      const { service } = buildDeps();
      service.start({ consultationId: CID, tenantId: TENANT });

      service.handleContextAdded({
        consultationId: CID,
        tenantId: TENANT,
        timestamp: new Date().toISOString(),
        contextItemId: 'ctx-worknote-1',
        contextType: 'WORKNOTE',
        contentPreview: 'Follow-up in 2 weeks',
      });

      expect(trackedNotes(service, CID)).toHaveLength(1);
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

    /** Pull the prompt sent to TEXT `/generate` on the most recent flush. */
    const lastTextPrompt = (httpMock: ReturnType<typeof buildHttpMock>): string => {
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

      // The enriched (not the stale placeholder) content reaches the TEXT prompt once.
      await service.flush(CID, { force: true });
      const prompt = lastTextPrompt(httpMock);
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
