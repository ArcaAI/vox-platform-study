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
import { Subject } from 'rxjs';
import { LiveDocumentationService } from '../live-documentation.service';

const CID = 'consultation-001';
const TENANT = 'tenant-abc';
const CHANNEL = `consultation:live-summary:${CID}`;

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

function buildDeps(httpMock = buildHttpMock()) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  const redisSubscriber = {
    subscribeToChannel: vi.fn(),
    unsubscribeFromChannel: vi.fn(),
  };
  const audioBridge = {
    subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) }),
    unsubscribeFromResults: vi.fn(),
  };
  const contextItemRepository = {
    create: vi.fn().mockResolvedValue({ id: 'ctx-pre-1' }),
    findTranscripts: vi.fn().mockResolvedValue([]),
  };
  const configService = { get: vi.fn().mockReturnValue(undefined) };

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
});
