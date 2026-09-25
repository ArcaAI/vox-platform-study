/**
 * TranscriptionRealtimeService Unit Tests
 *
 * Tests the orchestration service that creates transcription jobs,
 * dispatches Dramatiq messages, and assembles SSE streams.
 *
 * Testing Strategy:
 * - Mock TranscriptionJobService (DB boundary)
 * - Mock RedisSubscriberService (Redis boundary)
 * - Mock IRedisCacheService (Redis boundary for lpush/publish)
 * - Verify the Dramatiq message format and the SSE assembly (`buildSseStream`)
 * - Test reconnection (subscribeToJob) with different job states
 * - Test SSE stream behavior (message forwarding, terminal detection, cleanup)
 */

import { MessageEvent } from '@nestjs/common';
import { Subject, firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { take } from 'rxjs/operators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IRedisCacheService } from '../../../baseServices/redis/redis-cache.service';
import { TranscriptionEventType } from '../dto';
import { TranscriptionRealtimeService } from '../transcriptionRealtime.service';

// Mock uuidv7 for deterministic message IDs
vi.mock('uuidv7', () => ({
  uuidv7: vi.fn(() => 'test-uuid-1234'),
}));

describe('TranscriptionRealtimeService', () => {
  let service: TranscriptionRealtimeService;
  let mockRedisSubscriber: any;
  let mockTranscriptionJobService: any;
  let mockCacheService: IRedisCacheService;
  let channelSubject: Subject<string>;

  // Helper: parse SSE MessageEvent data
  const parseEvent = (event: MessageEvent) => JSON.parse(event.data as string);

  beforeEach(() => {
    vi.clearAllMocks();
    channelSubject = new Subject<string>();

    mockRedisSubscriber = {
      subscribeToChannel: vi.fn().mockResolvedValue(channelSubject.asObservable()),
      unsubscribeFromChannel: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };

    mockTranscriptionJobService = {
      getById: vi.fn().mockResolvedValue({
        id: 'job-001',
        status: 'PROCESSING',
      }),
      recordDispatchEnvelope: vi.fn().mockResolvedValue(undefined),
    };

    mockCacheService = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      setex: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
      delMany: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(false),
      publish: vi.fn().mockResolvedValue(undefined),
      lpush: vi.fn().mockResolvedValue(1),
      rpush: vi.fn().mockResolvedValue(1),
      hset: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
    };

    service = new TranscriptionRealtimeService(mockRedisSubscriber as any, mockTranscriptionJobService as any, mockCacheService);
  });

  afterEach(() => {
    channelSubject.complete();
    vi.restoreAllMocks();
  });

  /** The gateway-resolved ASR spec every dispatch carries — the job's one selector (TASK-1006). */
  const SPEC = {
    runtimeKey: 'agent-v-1',
    agent: { slug: 'platform-transcription', versionId: 'agent-v-1' },
    models: { asr: { slug: 'whisper-large-v3-turbo' } },
    audioFrontEnd: { diarization: { enabled: false } },
  } as never;

  /**
   * TASK-1006 — `createAndStream` (create a `pipelineId`-keyed job, dispatch it, stream it) went
   * with the pipeline path; it had no production caller. The SSE assembly its tests exercised is
   * the service's own `buildSseStream`, driven here directly over the same Redis subject.
   */
  const streamFor = (jobId = 'job-001') => ({
    events$: (
      service as unknown as { buildSseStream: (id: string, channel: string, messages: unknown) => import('rxjs').Observable<MessageEvent> }
    ).buildSseStream(jobId, `stt:transcription:${jobId}`, channelSubject.asObservable()),
  });

  // -----------------------------------------------------------------------
  // dispatchDramatiqJob — audioBucketName forwarding
  // -----------------------------------------------------------------------

  describe('dispatchDramatiqJob audioBucketName', () => {
    it('uses provided audioBucketName as 9th positional arg', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-99',
        tenantId: 'tenant-1',
        audioUri: 's3://hope-audio-arcaai/x.wav',
        resolvedSpec: SPEC,
        audioBucketName: 'hope-audio-arcaai',
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);
      expect(message.args[8]).toBe('hope-audio-arcaai');
    });

    it('falls back to "hope-audio" when audioBucketName is omitted', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-99',
        tenantId: 'tenant-1',
        audioUri: 's3://hope-audio/x.wav',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);
      expect(message.args[8]).toBe('hope-audio');
    });
  });

  // -----------------------------------------------------------------------
  // dispatchDramatiqJob — voice profiles (TASK-887)
  // -----------------------------------------------------------------------

  describe('dispatchDramatiqJob voice profiles', () => {
    const specWith = (opts: { enabled: boolean; embeddingSlug?: string }): any => ({
      models: { asr: { slug: 'whisper' }, ...(opts.embeddingSlug ? { embedding: { slug: opts.embeddingSlug } } : {}) },
      audioFrontEnd: { diarization: { enabled: opts.enabled } },
    });

    // `userId` is explicit, never defaulted: passing `undefined` to a defaulted parameter
    // would silently restore the default and make the no-user case test nothing.
    const dispatch = async (voiceProfileService: unknown, resolvedSpec: unknown, userId: string | undefined) => {
      const svc = new TranscriptionRealtimeService(
        mockRedisSubscriber as any,
        mockTranscriptionJobService as any,
        mockCacheService,
        voiceProfileService as never,
      );
      await svc.dispatchDramatiqJob({
        jobId: 'job-vp',
        tenantId: 'tenant-1',
        audioUri: 's3://hope-audio/x.wav',
        userId,
        resolvedSpec: resolvedSpec as never,
      });
      return JSON.parse((mockCacheService.hset as any).mock.calls[0][2]).kwargs as Record<string, unknown>;
    };

    it('carries the job user’s profiles for the agent’s embedding model', async () => {
      const listForRuntime = vi.fn().mockResolvedValue([{ profile_id: 'vp-1', label: 'Dr Who', model_id: 'ecapa-tdnn-voxceleb', embedding: [0.1] }]);
      const kwargs = await dispatch({ listForRuntime }, specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }), 'user-1');

      expect(listForRuntime).toHaveBeenCalledWith('user-1', 'tenant-1', 'ecapa-tdnn-voxceleb');
      expect(kwargs.voice_profiles).toEqual([{ profile_id: 'vp-1', label: 'Dr Who', model_id: 'ecapa-tdnn-voxceleb', embedding: [0.1] }]);
    });

    it('OMITS the kwarg entirely when there is nothing to send — absence is the one encoding', async () => {
      const kwargs = await dispatch(
        { listForRuntime: vi.fn().mockResolvedValue([]) },
        specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }),
        'user-1',
      );
      expect(kwargs).not.toHaveProperty('voice_profiles');
    });

    it('does not query at all with diarization off, no embedding model, or no user', async () => {
      const listForRuntime = vi.fn();
      await dispatch({ listForRuntime }, specWith({ enabled: false, embeddingSlug: 'ecapa-tdnn-voxceleb' }), 'user-1');
      await dispatch({ listForRuntime }, specWith({ enabled: true }), 'user-1');
      await dispatch({ listForRuntime }, specWith({ enabled: true, embeddingSlug: 'ecapa-tdnn-voxceleb' }), undefined);
      expect(listForRuntime).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // dispatchDramatiqJob — no pipeline on the wire (TASK-1006)
  //
  // The actor's positional order is (job_id, tenant_id, pipeline_id, audio_uri,
  // consultation_id, media_id, language, code_switching, audio_bucket_name, user_id,
  // storage, fallback_pipeline_id). The ARITY is kept (a message already queued stays
  // valid), but `pipeline_id` is always `None` and `fallback_pipeline_id` is never sent:
  // the resolved spec — a kwarg — carries the engine chain, fallback included.
  // -----------------------------------------------------------------------

  describe('dispatchDramatiqJob — the spec is the only selector', () => {
    const dispatchAndRead = async (extra: Record<string, unknown>) => {
      await service.dispatchDramatiqJob({
        jobId: 'job-77',
        tenantId: 'tenant-1',
        audioUri: 's3://hope-audio/x.wav',
        resolvedSpec: SPEC,
        ...extra,
      } as never);
      return JSON.parse((mockCacheService.hset as any).mock.calls[0][2]);
    };

    it('keeps 10 positional args, `None` in the retired pipeline_id slot, and the spec as a kwarg', async () => {
      const message = await dispatchAndRead({});

      expect(message.args).toHaveLength(10);
      expect(message.args[2]).toBeNull();
      expect(message.kwargs.resolved_spec).toEqual(SPEC);
      expect('fallback_pipeline_id' in message.kwargs).toBe(false);
    });

    it('carries a per-tenant storage descriptor beside the spec', async () => {
      const message = await dispatchAndRead({ storage: { provider: 's3', bucket: 'tenant-bucket' } });

      expect(message.kwargs.storage).toEqual({ provider: 's3', bucket: 'tenant-bucket' });
      expect(message.kwargs.resolved_spec).toEqual(SPEC);
    });
  });

  // -----------------------------------------------------------------------
  // subscribeToJob
  // -----------------------------------------------------------------------

  describe('subscribeToJob', () => {
    it('should emit INVALID_JOB_ID for empty id', async () => {
      const events$ = service.subscribeToJob('   ');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.type).toBe(TranscriptionEventType.ERROR);
      expect(parsed.data.errorCode).toBe('INVALID_JOB_ID');
      expect(mockTranscriptionJobService.getById).not.toHaveBeenCalled();
    });

    it('should emit error when job not found', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce(null);

      const events$ = service.subscribeToJob('nonexistent-job');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.type).toBe(TranscriptionEventType.ERROR);
      expect(parsed.data.errorCode).toBe('JOB_NOT_FOUND');
    });

    it('should emit final status when job is COMPLETED', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'COMPLETED',
      });

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.type).toBe(TranscriptionEventType.STATUS);
      expect(parsed.data.status).toBe('COMPLETED');
    });

    it('should emit final status when job is FAILED', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'FAILED',
      });

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.data.status).toBe('FAILED');
    });

    it('should emit final status when job is CANCELLED', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'CANCELLED',
      });

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.data.status).toBe('CANCELLED');
    });

    it('should emit final status when job is DEAD', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'DEAD',
      });

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.data.status).toBe('DEAD');
    });

    it('should subscribe to Redis when job is PROCESSING', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'PROCESSING',
      });

      const events$ = service.subscribeToJob('job-001');
      const collected: MessageEvent[] = [];

      const sub = events$.subscribe({
        next: (event) => collected.push(event),
      });

      // Allow async getById to resolve
      await new Promise((r) => setImmediate(r));

      expect(mockRedisSubscriber.subscribeToChannel).toHaveBeenCalledWith('stt:transcription:job-001');

      // First event is current status
      expect(collected.length).toBeGreaterThanOrEqual(1);
      const firstParsed = parseEvent(collected[0]);
      expect(firstParsed.type).toBe(TranscriptionEventType.STATUS);
      expect(firstParsed.data.status).toBe('PROCESSING');

      sub.unsubscribe();
    });

    it('should subscribe to Redis when job is QUEUED', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'QUEUED',
      });

      const events$ = service.subscribeToJob('job-001');
      const sub = events$.subscribe();

      await new Promise((r) => setImmediate(r));

      expect(mockRedisSubscriber.subscribeToChannel).toHaveBeenCalled();
      sub.unsubscribe();
    });

    it('should handle getById error gracefully', async () => {
      mockTranscriptionJobService.getById.mockRejectedValueOnce(new Error('Database error'));

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.type).toBe(TranscriptionEventType.ERROR);
      expect(parsed.data.errorCode).toBe('RECONNECTION_ERROR');
    });
  });

  // -----------------------------------------------------------------------
  // SSE stream behavior
  // -----------------------------------------------------------------------

  describe('SSE stream', () => {
    it('should forward chunk events from Redis', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (event) => collected.push(event),
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: {
            jobId: 'job-001',
            chunkIndex: 0,
            text: 'Hello world',
            startTime: 0,
            endTime: 2.5,
            isFinal: false,
          },
        }),
      );

      expect(collected).toHaveLength(1);
      const parsed = parseEvent(collected[0]);
      expect(parsed.type).toBe('chunk');
      expect(parsed.data.text).toBe('Hello world');

      sub.unsubscribe();
    });

    it('should include event type and id in MessageEvent', async () => {
      const { events$ } = streamFor();

      const firstEvent = firstValueFrom(events$.pipe(take(1)));

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.PROGRESS,
          data: { jobId: 'job-001', progress: 25 },
        }),
      );

      const event = await firstEvent;
      expect(event.type).toBe('progress');
      expect(event.id).toBeDefined();
      expect(event.id).toContain('job-001');
    });

    it('should auto-complete when COMPLETED status received', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      let completed = false;

      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      // Send a chunk
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: { jobId: 'job-001', chunkIndex: 0, text: 'Hello', startTime: 0, endTime: 1, isFinal: false },
        }),
      );

      // Send terminal status
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'COMPLETED', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(true);
      expect(collected).toHaveLength(2);

      // The terminal event should be included
      const lastParsed = parseEvent(collected[1]);
      expect(lastParsed.data.status).toBe('COMPLETED');
    });

    it('should auto-complete when FAILED status received', async () => {
      const { events$ } = streamFor();

      let completed = false;
      events$.subscribe({
        complete: () => {
          completed = true;
        },
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'FAILED', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(true);
    });

    it('should auto-complete when CANCELLED status received', async () => {
      const { events$ } = streamFor();

      let completed = false;
      const collected: MessageEvent[] = [];
      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'CANCELLED', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(true);
      expect(collected).toHaveLength(1);
      const parsed = parseEvent(collected[0]);
      expect(parsed.data.status).toBe('CANCELLED');
    });

    it('should auto-complete when DEAD status received', async () => {
      const { events$ } = streamFor();

      let completed = false;
      const collected: MessageEvent[] = [];
      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'DEAD', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(true);
      expect(collected).toHaveLength(1);
      const parsed = parseEvent(collected[0]);
      expect(parsed.data.status).toBe('DEAD');
    });

    it('should handle malformed Redis messages gracefully', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (event) => collected.push(event),
      });

      // Send malformed message
      channelSubject.next('not-valid-json{{{');

      // Should still forward it (with raw data) and not crash
      expect(collected).toHaveLength(1);
      expect(collected[0].data).toBe('not-valid-json{{{');

      sub.unsubscribe();
    });

    it('should clean up Redis subscription on stream finalize', async () => {
      const { events$ } = streamFor();

      events$.subscribe();

      // Send terminal status to trigger completion and finalize
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'COMPLETED', timestamp: new Date().toISOString() },
        }),
      );

      expect(mockRedisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith('stt:transcription:job-001');
    });

    it('should not complete on non-terminal status events', async () => {
      const { events$ } = streamFor();

      let completed = false;
      const sub = events$.subscribe({
        complete: () => {
          completed = true;
        },
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'PROCESSING', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(false);
      sub.unsubscribe();
    });
  });

  // -----------------------------------------------------------------------
  // Dramatiq message format
  // -----------------------------------------------------------------------

  describe('Dramatiq message format', () => {
    it('should use correct queue and actor names', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);

      expect(message.queue_name).toBe('stt_batch');
      expect(message.actor_name).toBe('transcribe_file');
    });

    it('should include all required Dramatiq message fields', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);

      expect(message).toHaveProperty('queue_name');
      expect(message).toHaveProperty('actor_name');
      expect(message).toHaveProperty('args');
      expect(message).toHaveProperty('kwargs');
      expect(message).toHaveProperty('options');
      expect(message).toHaveProperty('options.redis_message_id');
      expect(message).toHaveProperty('message_id');
      expect(message).toHaveProperty('message_timestamp');
    });

    it('should include redis_message_id in options', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);

      expect(message.options.redis_message_id).toBeDefined();
      expect(message.options.redis_message_id).toBeTypeOf('string');
    });

    it('should pass args in correct order matching Python actor signature', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        consultationId: 'consult-1',
        mediaId: 'media-1',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);

      // Must match: transcribe_file(job_id, tenant_id, pipeline_id, audio_uri, consultation_id, media_id)
      expect(message.args[0]).toBe('job-001'); // job_id
      expect(message.args[1]).toBe('tenant-1'); // tenant_id
      expect(message.args[2]).toBeNull(); // pipeline_id — retired (TASK-1006), always None
      expect(message.args[3]).toBe('minio://audio/test.wav'); // audio_uri
      expect(message.args[4]).toBe('consult-1'); // consultation_id
      expect(message.args[5]).toBe('media-1'); // media_id
    });

    it('should use HSET for message storage and RPUSH for queue', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      // HSET stores payload in the .msgs hash
      expect(mockCacheService.hset).toHaveBeenCalledWith('dramatiq:stt_batch.msgs', expect.any(String), expect.any(String));

      // RPUSH pushes message ID (not payload) to the queue
      expect(mockCacheService.rpush).toHaveBeenCalledWith('dramatiq:stt_batch', expect.any(String));

      // The RPUSH value should be the message_id, not the full JSON
      const rpushValue = (mockCacheService.rpush as any).mock.calls[0][1];
      expect(() => JSON.parse(rpushValue)).toThrow(); // It's a UUID, not JSON
    });
  });

  // -----------------------------------------------------------------------
  // Dramatiq protocol integration (HSET + RPUSH + PUBLISH)
  // -----------------------------------------------------------------------

  describe('Dramatiq protocol integration', () => {
    it('should use hset+rpush for queue dispatch and publish only for notification', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      // hset should be called once to store message payload
      expect(mockCacheService.hset).toHaveBeenCalledTimes(1);

      // rpush should be called once to enqueue message ID
      expect(mockCacheService.rpush).toHaveBeenCalledTimes(1);

      // lpush should NOT be called (old protocol)
      expect(mockCacheService.lpush).not.toHaveBeenCalled();

      // publish should be called only for the notification event
      expect(mockCacheService.publish).toHaveBeenCalledTimes(1);
      expect(mockCacheService.publish).toHaveBeenCalledWith('dramatiq:__events__', 'stt_batch');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and error paths
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle publish notification failure after hset+rpush success', async () => {
      (mockCacheService.publish as any).mockRejectedValueOnce(new Error('Publish notification failed'));

      await expect(
        service.dispatchDramatiqJob({
          jobId: 'job-001',
          tenantId: 'tenant-1',
          audioUri: 'minio://audio/test.wav',
          resolvedSpec: SPEC,
        }),
      ).rejects.toThrow('Publish notification failed');

      // hset and rpush were still called
      expect(mockCacheService.hset).toHaveBeenCalledTimes(1);
      expect(mockCacheService.rpush).toHaveBeenCalledTimes(1);
    });

    it('should forward multiple rapid events in order', async () => {
      const { events$ } = streamFor();

      const collected: string[] = [];
      const sub = events$.subscribe({
        next: (event) => {
          const parsed = parseEvent(event);
          collected.push(`${parsed.type}:${parsed.data.progress ?? parsed.data.chunkIndex ?? parsed.data.status}`);
        },
      });

      // Send events rapidly
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'PROCESSING', timestamp: new Date().toISOString() },
        }),
      );
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.PROGRESS,
          data: { jobId: 'job-001', progress: 25 },
        }),
      );
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: { jobId: 'job-001', chunkIndex: 0, text: 'Hello', startTime: 0, endTime: 1, isFinal: false },
        }),
      );
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.PROGRESS,
          data: { jobId: 'job-001', progress: 50 },
        }),
      );
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: { jobId: 'job-001', chunkIndex: 1, text: 'World', startTime: 1, endTime: 2, isFinal: true },
        }),
      );

      expect(collected).toEqual(['status:PROCESSING', 'progress:25', 'chunk:0', 'progress:50', 'chunk:1']);

      sub.unsubscribe();
    });

    it('should handle empty string audio URI', async () => {
      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: '',
        resolvedSpec: SPEC,
      });

      const messageJson = (mockCacheService.hset as any).mock.calls[0][2];
      const message = JSON.parse(messageJson);

      expect(message.args[3]).toBe('');
    });

    it('should not dispatch events after stream completes via FAILED', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      let completed = false;

      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      // Send failure status
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'FAILED', timestamp: new Date().toISOString() },
        }),
      );

      expect(completed).toBe(true);

      // Try to send more events after completion
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: { jobId: 'job-001', chunkIndex: 999, text: 'Late', startTime: 0, endTime: 1, isFinal: false },
        }),
      );

      // Should only have the FAILED event
      expect(collected).toHaveLength(1);
    });

    it('subscribeToJob should handle error event gracefully', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'PROCESSING',
      });

      const events$ = service.subscribeToJob('job-001');
      const collected: MessageEvent[] = [];

      const sub = events$.subscribe({
        next: (event) => collected.push(event),
      });

      await new Promise((r) => setImmediate(r));

      // First event is current PROCESSING status
      expect(collected.length).toBeGreaterThanOrEqual(1);

      // Send an error event via Redis
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.ERROR,
          data: { jobId: 'job-001', errorCode: 'MODEL_ERROR', message: 'Inference failed' },
        }),
      );

      // Error event should be forwarded (not terminal, doesn't close stream)
      const errorEvent = collected.find((e) => {
        const p = parseEvent(e);
        return p.type === TranscriptionEventType.ERROR;
      });
      expect(errorEvent).toBeDefined();

      sub.unsubscribe();
    });

    it('should handle transcript event (non-terminal) in stream', async () => {
      const { events$ } = streamFor();

      let completed = false;
      const sub = events$.subscribe({
        complete: () => {
          completed = true;
        },
      });

      // Transcript event is NOT terminal — only status events with COMPLETED/FAILED are
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.TRANSCRIPT,
          data: {
            jobId: 'job-001',
            text: 'Full transcript',
            durationSeconds: 120,
            processingTimeSeconds: 5,
            wordTimestamps: [],
            sentenceTimestamps: [],
            metadata: {},
          },
        }),
      );

      expect(completed).toBe(false);
      sub.unsubscribe();
    });
  });

  // -----------------------------------------------------------------------
  // Subscribe-before-dispatch ordering (race-condition prevention)
  // -----------------------------------------------------------------------

  describe('subscribe-before-dispatch ordering', () => {
    it('should store (hset), enqueue (rpush) and only then notify (publish)', async () => {
      const callOrder: string[] = [];

      (mockCacheService.hset as any).mockImplementation(async () => {
        callOrder.push('hset');
      });
      (mockCacheService.rpush as any).mockImplementation(async () => {
        callOrder.push('rpush');
        return 1;
      });
      (mockCacheService.publish as any).mockImplementation(async () => {
        callOrder.push('publish');
      });

      await service.dispatchDramatiqJob({
        jobId: 'job-001',
        tenantId: 'tenant-1',
        audioUri: 'minio://audio/test.wav',
        resolvedSpec: SPEC,
      });

      expect(callOrder).toEqual(['hset', 'rpush', 'publish']);
    });
  });

  // -----------------------------------------------------------------------
  // SSE stream: malformed messages in takeWhile
  // -----------------------------------------------------------------------

  describe('SSE stream: malformed message resilience', () => {
    it('should not crash on unparseable JSON in takeWhile check', async () => {
      const { events$ } = streamFor();

      let completed = false;
      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (e) => collected.push(e),
        complete: () => {
          completed = true;
        },
      });

      // Malformed message => map catch returns raw string as data,
      // takeWhile catch returns true (continue streaming)
      channelSubject.next('{invalid json');
      expect(completed).toBe(false);
      expect(collected).toHaveLength(1);
      expect(collected[0].data).toBe('{invalid json');

      // Valid events still work after malformed one
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.PROGRESS,
          data: { jobId: 'job-001', progress: 50 },
        }),
      );
      expect(collected).toHaveLength(2);
      expect(parseEvent(collected[1]).data.progress).toBe(50);

      sub.unsubscribe();
    });

    it('should handle very long malformed message (tests substring(0,200) in logger)', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (e) => collected.push(e),
      });

      const longMessage = 'z'.repeat(500);
      channelSubject.next(longMessage);

      expect(collected).toHaveLength(1);
      expect(collected[0].data).toBe(longMessage);

      sub.unsubscribe();
    });
  });

  // -----------------------------------------------------------------------
  // subscribeToJob: forward Redis events for reconnected in-progress jobs
  // -----------------------------------------------------------------------

  describe('subscribeToJob: reconnection event forwarding', () => {
    it('should forward Redis events through to subscriber for PROCESSING job', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'PROCESSING',
      });

      const events$ = service.subscribeToJob('job-001');
      const collected: MessageEvent[] = [];

      const sub = events$.subscribe({
        next: (event) => collected.push(event),
      });

      await new Promise((r) => setImmediate(r));

      // First event is current status
      expect(collected.length).toBe(1);
      expect(parseEvent(collected[0]).data.status).toBe('PROCESSING');

      // Forward Redis events
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.PROGRESS,
          data: { jobId: 'job-001', progress: 80 },
        }),
      );

      expect(collected).toHaveLength(2);
      expect(parseEvent(collected[1]).data.progress).toBe(80);

      sub.unsubscribe();
    });

    it('should complete when reconnected stream receives terminal status', async () => {
      mockTranscriptionJobService.getById.mockResolvedValueOnce({
        id: 'job-001',
        status: 'QUEUED',
      });

      const events$ = service.subscribeToJob('job-001');
      let completed = false;
      const collected: MessageEvent[] = [];

      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      await new Promise((r) => setImmediate(r));

      // Send COMPLETED via Redis
      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.STATUS,
          data: { jobId: 'job-001', status: 'COMPLETED', timestamp: '2026-02-10T12:00:00Z' },
        }),
      );

      expect(completed).toBe(true);
      // QUEUED status + COMPLETED status
      expect(collected.length).toBe(2);
    });

    it('should handle non-Error thrown by getById', async () => {
      mockTranscriptionJobService.getById.mockRejectedValueOnce('string error');

      const events$ = service.subscribeToJob('job-001');
      const events = await lastValueFrom(events$.pipe(toArray()));

      expect(events).toHaveLength(1);
      const parsed = parseEvent(events[0]);
      expect(parsed.type).toBe(TranscriptionEventType.ERROR);
      expect(parsed.data.errorCode).toBe('RECONNECTION_ERROR');
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle end-to-end
  // -----------------------------------------------------------------------

  describe('full event lifecycle', () => {
    it('should handle complete transcription lifecycle with cleanup', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      let completed = false;

      events$.subscribe({
        next: (event) => collected.push(event),
        complete: () => {
          completed = true;
        },
      });

      // Full lifecycle: PROCESSING → progress → chunk → transcript → COMPLETED
      const events = [
        { type: TranscriptionEventType.STATUS, data: { jobId: 'job-001', status: 'PROCESSING', timestamp: '2026-02-10T00:00:01Z' } },
        { type: TranscriptionEventType.PROGRESS, data: { jobId: 'job-001', progress: 25, stage: 'preprocessing' } },
        { type: TranscriptionEventType.CHUNK, data: { jobId: 'job-001', chunkIndex: 0, text: 'Hello', startTime: 0, endTime: 1.5, isFinal: false } },
        { type: TranscriptionEventType.PROGRESS, data: { jobId: 'job-001', progress: 75, stage: 'inference' } },
        { type: TranscriptionEventType.CHUNK, data: { jobId: 'job-001', chunkIndex: 1, text: 'World', startTime: 1.5, endTime: 3.0, isFinal: true } },
        { type: TranscriptionEventType.PROGRESS, data: { jobId: 'job-001', progress: 100, stage: 'postprocessing' } },
        {
          type: TranscriptionEventType.TRANSCRIPT,
          data: {
            jobId: 'job-001',
            text: 'Hello World',
            durationSeconds: 3.0,
            processingTimeSeconds: 1.5,
            wordTimestamps: [],
            sentenceTimestamps: [],
            metadata: {},
          },
        },
        { type: TranscriptionEventType.STATUS, data: { jobId: 'job-001', status: 'COMPLETED', timestamp: '2026-02-10T00:00:05Z' } },
      ];

      for (const evt of events) {
        channelSubject.next(JSON.stringify(evt));
      }

      expect(completed).toBe(true);
      expect(collected).toHaveLength(8);

      // Verify type sequence
      const types = collected.map((e) => parseEvent(e).type);
      expect(types).toEqual(['status', 'progress', 'chunk', 'progress', 'chunk', 'progress', 'transcript', 'status']);

      // Verify finalize cleanup
      expect(mockRedisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith('stt:transcription:job-001');
    });
  });

  // -----------------------------------------------------------------------
  // SSE MessageEvent structure
  // -----------------------------------------------------------------------

  describe('SSE MessageEvent structure', () => {
    it('should include type and id fields in MessageEvent for valid events', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (e) => collected.push(e),
      });

      channelSubject.next(
        JSON.stringify({
          type: TranscriptionEventType.CHUNK,
          data: { jobId: 'job-001', chunkIndex: 0, text: 'Hi', startTime: 0, endTime: 0.5, isFinal: false },
        }),
      );

      expect(collected[0].type).toBe('chunk');
      expect(collected[0].id).toBeDefined();
      expect(collected[0].id as string).toContain('job-001');

      sub.unsubscribe();
    });

    it('should NOT include type/id fields for malformed messages', async () => {
      const { events$ } = streamFor();

      const collected: MessageEvent[] = [];
      const sub = events$.subscribe({
        next: (e) => collected.push(e),
      });

      channelSubject.next('not json');

      // Malformed: data is the raw string, no type or id
      expect(collected[0].data).toBe('not json');
      expect(collected[0].type).toBeUndefined();
      expect(collected[0].id).toBeUndefined();

      sub.unsubscribe();
    });
  });
});
