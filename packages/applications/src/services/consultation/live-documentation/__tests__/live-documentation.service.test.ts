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
          return Promise.resolve({ data: { entities: [{ type: 'MEDICATION', value: 'amlodipine', confidence: 0.92, start: 3, end: 13 }] } });
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisSubscriber?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contextItemRepository?: any;
}

function buildDeps(httpMock = buildHttpMock(), opts: BuildDepsOpts = {}) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue('OK'),
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
  };
  const config = opts.config ?? {};
  const configService = { get: vi.fn().mockImplementation((key: string) => config[key]) };

  const service = new LiveDocumentationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    httpMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cacheService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisSubscriber as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audioBridge as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextItemRepository as any,
  );

  return { service, cacheService, redisSubscriber, audioBridge, contextItemRepository, httpMock };
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
      expect(payload!.entities).toEqual([{ text: 'amlodipine', type: 'MEDICATION', confidence: 0.92, start: 3, end: 13 }]);
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
                data: { entities: [{ type: 'MEDICATION', value: 'amlodipine', confidence: 0.9, start, end: start + 'amlodipine'.length }] },
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

    it('runs NER over runningSummary so entity offsets index the rendered text', async () => {
      const httpMock = soapHttpMock();
      const { service } = buildDeps(httpMock);
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'Patient has chest pain', isFinal: true, segmentId: 's1' });

      const payload = await service.flush(CID);

      // NLP was handed the runningSummary, not the raw transcript.
      const nlpCall = httpMock.axiosRef.post.mock.calls.find((c) => String(c[0]).includes('/classify/tokens'))!;
      expect(nlpCall[1].text).toBe(payload!.runningSummary);

      // The returned offsets resolve to the exact span within runningSummary.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  describe('overlapping flushes (P0-A)', () => {
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
  describe('bounded transcript cost (P0-B)', () => {
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

    it('sets bounded live SMR params (max_tokens, lower timeout, provider/model) and a SOAP response_format', async () => {
      const { service, httpMock } = buildDeps(buildHttpMock(), {
        config: {
          LIVE_DOC_SMR_MAX_TOKENS: '1500',
          LIVE_DOC_SMR_TIMEOUT_MS: '20000',
          LIVE_DOC_SMR_PROVIDER: 'openai',
          LIVE_DOC_SMR_MODEL: 'fast-model',
        },
      });
      service.start({ consultationId: CID, tenantId: TENANT });
      service.ingestSegment(CID, { text: 'hello', isFinal: true, segmentId: 's1' });
      await service.flush(CID);

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
  // P0-C: deterministic json_schema SOAP parse in the flush path
  // ------------------------------------------------------------------
  describe('deterministic SOAP parse (P0-C)', () => {
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
  describe('cross-instance resilience (P1-A)', () => {
    it('publishes a terminal closed event, frees the lock, and signals teardown even with no local session', async () => {
      const { service, cacheService } = buildDeps();
      const result = await service.stop('other-cid');

      expect(result).toBeNull();
      const publishes = cacheService.publish.mock.calls.map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]);
      // terminal closed on the main channel
      expect(publishes.some(([ch, p]: [string, { closed?: boolean }]) => ch === 'consultation:live-summary:other-cid' && p.closed === true)).toBe(true);
      // stop signal on the control channel (so an owner on another instance tears down)
      expect(publishes.some(([ch, p]: [string, { type?: string }]) => ch === 'consultation:live-summary:other-cid:control' && p.type === 'stop')).toBe(true);
      // owner lock released
      expect(cacheService.del).toHaveBeenCalledWith('consultation:live-summary:other-cid:lock');
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
  // P1-C: throttled durable snapshot (single upserted ContextItem)
  // ------------------------------------------------------------------
  describe('durable snapshot (P1-C)', () => {
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
  });

  // ------------------------------------------------------------------
  // P2: kill-switch + metrics
  // ------------------------------------------------------------------
  describe('safety rails + observability (P2)', () => {
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
  // B1 (TASK-341): per-session stats published to Redis for the admin
  // live console — `live-doc:stats:{cid}` snapshot + `live-doc:active:{tenant}` set.
  // ------------------------------------------------------------------
  describe('admin live stats publish/clear (B1)', () => {
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
  // B3 (TASK-341): runtime kill-switch — env default + Redis override.
  // ------------------------------------------------------------------
  describe('runtime kill-switch (B3)', () => {
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
  // GAP #3d (TASK-342): live drop-out of a soft-deleted context note.
  // contextNotes are re-keyed by contextItemId so a removed note can be
  // dropped precisely from the in-flight running summary.
  // ------------------------------------------------------------------
  describe('context drop-out (GAP #3d)', () => {
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
  // TASK-344: OCR enrichment re-emits ContextAdded for the SAME
  // contextItemId once it has extracted text. The add path UPSERTS by
  // contextItemId so the attachment yields exactly ONE running-summary
  // note that is updated in place — no harmless-but-confusing duplicate.
  // ------------------------------------------------------------------
  describe('context note upsert on OCR re-emit (TASK-344)', () => {
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
