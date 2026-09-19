import { ConflictException, Inject, Injectable, Logger, MessageEvent, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Observable, finalize, map, takeWhile } from 'rxjs';
import type { ResolvedAsrSpec } from '@arcaai/types';
import { uuidv7 } from 'uuidv7';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import { StorageDescriptor } from '../../baseServices/storage/providers/IBlobStorageProvider';
import { IBlobStorageService } from '../../baseServices/storage/IBlobStorageService';
import type { BatchDispatchEnvelope, TranscriptionJobResponse } from '../job/dto';
import { TranscriptionJobService } from '../job/transcriptionJob.service';
import { TranscriptionEvent, TranscriptionEventType } from './dto';
import { ITranscriptionRealtimeService } from './ITranscriptionRealtimeService';
import { RedisSubscriberService } from './redisSubscriber.service';
import { IVoiceProfileService, RuntimeVoiceProfile } from '../../user/voiceProfile/IVoiceProfileService';

/**
 * Transcription Realtime Service
 *
 * Orchestrates the full real-time transcription flow:
 * 1. Create TranscriptionJob in DB (status: QUEUED)
 * 2. Dispatch Dramatiq message to stt_batch queue via Redis HSET+RPUSH
 * 3. Subscribe to Redis channel stt:transcription:{jobId}
 * 4. Assemble SSE Observable that forwards events to the client
 * 5. Auto-complete when terminal status (COMPLETED/FAILED/CANCELLED/DEAD) received
 *
 * Channel: stt:transcription:{jobId}
 * Queue: dramatiq:stt_batch
 */
@Injectable()
export class TranscriptionRealtimeService implements ITranscriptionRealtimeService {
  private readonly logger = new Logger(TranscriptionRealtimeService.name);
  private readonly CHANNEL_PREFIX = 'stt:transcription:';
  private readonly DRAMATIQ_QUEUE = 'dramatiq:stt_batch';
  private readonly DRAMATIQ_EVENTS_CHANNEL = 'dramatiq:__events__';

  constructor(
    private readonly redisSubscriber: RedisSubscriberService,
    private readonly transcriptionJobService: TranscriptionJobService,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    // TASK-887 — resolves the job user's ENROLLED voice profiles for the agent's embedding
    // model. Optional and trailing: without it a job still transcribes and diarizes, with
    // generic `Speaker N` labels. Resolved HERE rather than in each of the four callers so
    // every batch dispatch pushes the same thing.
    @Optional() @Inject(IVoiceProfileService) private readonly voiceProfileService?: IVoiceProfileService,
    // TASK-992 FU-1 — re-resolves the per-tenant `StorageDescriptor` on a retry.
    // The descriptor carries credentials, so it is never snapshotted on the row;
    // resolving it fresh is also what makes a rotation between attempts a
    // non-event. Optional + trailing so positional test construction keeps
    // compiling; absent, a retry that NEEDED one refuses rather than dispatching
    // a job that would look in the wrong backend.
    @Optional() @Inject(IBlobStorageService) private readonly blobStorage?: Pick<IBlobStorageService, 'resolveDescriptor'>,
  ) {}

  /**
   * Create a transcription job and return an SSE Observable.
   *
   * Flow:
   * 1. Create TranscriptionJob in DB (status: QUEUED)
   * 2. Subscribe to Redis channel stt:transcription:{jobId}
   * 3. Dispatch Dramatiq message to stt_batch queue via Redis HSET+RPUSH
   * 4. Emit initial { type: "status", data: { status: "QUEUED" } }
   * 5. Forward all Redis messages as SSE MessageEvent objects
   * 6. Complete Observable when terminal status received (COMPLETED/FAILED/CANCELLED/DEAD)
   */
  async createAndStream(params: {
    tenantId: string;
    pipelineId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    createdBy?: string;
    language?: string;
    codeSwitching?: boolean;
  }): Promise<{ jobId: string; events$: Observable<MessageEvent> }> {
    // 1. Create the transcription job in DB
    const jobResponse = await this.transcriptionJobService.createBatchJob({
      pipelineId: params.pipelineId,
      mediaId: params.mediaId ?? params.audioUri, // audioUri used as media reference
      consultationId: params.consultationId,
    });

    const jobId = jobResponse.id;
    const channel = `${this.CHANNEL_PREFIX}${jobId}`;

    this.logger.log({
      message: 'Created transcription job for realtime streaming',
      jobId,
      pipelineId: params.pipelineId,
      channel,
    });

    // 2. Subscribe to Redis channel BEFORE dispatching (avoid race condition)
    // Awaited to ensure the Redis SUBSCRIBE command completes before dispatch
    const redisMessages$ = await this.redisSubscriber.subscribeToChannel(channel);

    // 3. Dispatch Dramatiq message to the stt_batch queue
    await this.dispatchDramatiqJob({
      jobId,
      tenantId: params.tenantId,
      pipelineId: params.pipelineId,
      audioUri: params.audioUri,
      consultationId: params.consultationId,
      mediaId: params.mediaId,
    });

    // 4. Assemble SSE Observable
    const events$ = this.buildSseStream(jobId, channel, redisMessages$);

    return { jobId, events$ };
  }

  /**
   * Subscribe to an existing job's SSE stream (reconnection).
   *
   * Checks current job status first:
   * - If already terminal (COMPLETED/FAILED), emits the final status and completes
   * - Otherwise, subscribes to Redis channel and streams events
   */
  subscribeToJob(jobId: string): Observable<MessageEvent> {
    const id = jobId?.trim();
    if (!id) {
      return new Observable<MessageEvent>((subscriber) => {
        subscriber.next({
          data: JSON.stringify({
            type: TranscriptionEventType.ERROR,
            data: {
              jobId: null,
              errorCode: 'INVALID_JOB_ID',
              message: 'A valid jobId is required to subscribe to stream',
            },
          }),
        } as MessageEvent);
        subscriber.complete();
      });
    }

    const channel = `${this.CHANNEL_PREFIX}${id}`;

    return new Observable<MessageEvent>((subscriber) => {
      // Check current job status
      this.transcriptionJobService
        .getById(id)
        .then(async (job) => {
          if (!job) {
            subscriber.next({
              data: JSON.stringify({
                type: TranscriptionEventType.ERROR,
                data: {
                  jobId: id,
                  errorCode: 'JOB_NOT_FOUND',
                  message: `Job ${id} not found`,
                },
              }),
            } as MessageEvent);
            subscriber.complete();
            return;
          }

          const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'];
          if (terminalStatuses.includes(job.status)) {
            // Job already finished — emit final status and complete
            subscriber.next({
              data: JSON.stringify({
                type: TranscriptionEventType.STATUS,
                data: {
                  jobId: id,
                  status: job.status,
                  timestamp: new Date().toISOString(),
                },
              }),
            } as MessageEvent);
            subscriber.complete();
            return;
          }

          // Job is still in progress — subscribe to Redis channel
          const redisMessages$ = await this.redisSubscriber.subscribeToChannel(channel);
          const sseStream$ = this.buildSseStream(id, channel, redisMessages$);

          // Emit current status first, then forward Redis events
          subscriber.next({
            data: JSON.stringify({
              type: TranscriptionEventType.STATUS,
              data: {
                jobId: id,
                status: job.status,
                timestamp: new Date().toISOString(),
              },
            }),
          } as MessageEvent);

          sseStream$.subscribe({
            next: (event) => subscriber.next(event),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
        })
        .catch((error) => {
          this.logger.error({
            message: 'Error checking job status for reconnection',
            jobId: id,
            error: error instanceof Error ? error.message : String(error),
          });
          subscriber.next({
            data: JSON.stringify({
              type: TranscriptionEventType.ERROR,
              data: {
                jobId: id,
                errorCode: 'RECONNECTION_ERROR',
                message: 'Failed to reconnect to job stream',
              },
            }),
          } as MessageEvent);
          subscriber.complete();
        });
    });
  }

  /**
   * Build an SSE Observable from Redis Pub/Sub messages.
   *
   * Parses each raw Redis message as a TranscriptionEvent,
   * converts to SSE MessageEvent, and auto-completes when
   * a terminal status (COMPLETED/FAILED/CANCELLED/DEAD) is received.
   */
  private buildSseStream(jobId: string, channel: string, redisMessages$: Observable<string>): Observable<MessageEvent> {
    return redisMessages$.pipe(
      // Parse raw JSON and convert to SSE MessageEvent
      map((rawMessage: string): MessageEvent => {
        try {
          const event: TranscriptionEvent = JSON.parse(rawMessage);
          return {
            data: JSON.stringify(event),
            type: event.type,
            id: `${jobId}-${Date.now()}`,
          } as MessageEvent;
        } catch (error) {
          this.logger.warn({
            message: 'Failed to parse Redis message as TranscriptionEvent',
            channel,
            rawMessage: rawMessage.substring(0, 200),
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            data: rawMessage,
          } as MessageEvent;
        }
      }),
      // Auto-complete when terminal status is received
      takeWhile((event: MessageEvent) => {
        try {
          const parsed: TranscriptionEvent = JSON.parse(event.data as string);
          if (parsed.type === TranscriptionEventType.STATUS) {
            const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'].includes(parsed.data.status);
            if (isTerminal) {
              this.logger.log({
                message: 'SSE stream ending — terminal status received',
                jobId,
                status: parsed.data.status,
              });
            }
            return !isTerminal;
          }
        } catch {
          // If we can't parse, continue streaming
        }
        return true;
      }, true), // Include the terminal event in the stream
      // Clean up Redis subscription when stream completes
      finalize(() => {
        this.logger.log({
          message: 'SSE stream finalized — cleaning up Redis subscription',
          jobId,
          channel,
        });
        this.redisSubscriber.unsubscribeFromChannel(channel);
      }),
    );
  }

  /**
   * Emit a completion event to the SSE stream for a given job.
   */
  async emitCompleteEvent(jobId: string): Promise<void> {
    const channel = `${this.CHANNEL_PREFIX}${jobId}`;
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.STATUS,
      data: {
        jobId,
        status: 'COMPLETED',
        timestamp: new Date().toISOString(),
      },
    };
    await this.cacheService.publish(channel, JSON.stringify(event));
  }

  /**
   * Emit an error event to the SSE stream for a given job.
   */
  async emitErrorEvent(jobId: string, message: string): Promise<void> {
    const channel = `${this.CHANNEL_PREFIX}${jobId}`;
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.ERROR,
      data: {
        jobId,
        errorCode: 'TRANSCRIPTION_ERROR',
        message,
      },
    };
    await this.cacheService.publish(channel, JSON.stringify(event));
  }

  /**
   * Dispatch a Dramatiq message to the stt_batch queue.
   *
   * Dramatiq's RedisBroker protocol requires:
   * 1. HSET dramatiq:stt_batch.msgs <message_id> <encoded_json>
   * 2. RPUSH dramatiq:stt_batch <message_id>
   * 3. PUBLISH dramatiq:__events__ stt_batch
   *
   * Workers BRPOP the queue to get a message_id, then HMGET from
   * the .msgs hash to retrieve the full payload. Using LPUSH with
   * the full JSON (the previous approach) would cause workers to
   * look up the raw JSON as a key in the hash and find nothing.
   *
   * The message also requires a `redis_message_id` in options
   * (a separate UUID from message_id) per Dramatiq's protocol.
   */
  /**
   * TASK-887 — the job user's ENROLLED voice profiles, filtered to the agent's
   * speaker-embedding model, for the Dramatiq message.
   *
   * Same rule as the streaming path: nothing is resolved unless the job will use it
   * (diarization on, an embedding model bound, a user to attribute), and the model is a
   * WHERE clause rather than a post-filter — profiles from another embedding space are not
   * comparable, so they are never fetched.
   */
  private async resolveVoiceProfiles(params: { tenantId: string; userId?: string; resolvedSpec?: ResolvedAsrSpec }): Promise<RuntimeVoiceProfile[]> {
    const modelId = params.resolvedSpec?.models.embedding?.slug;
    if (!this.voiceProfileService || !params.userId || !params.resolvedSpec?.audioFrontEnd.diarization.enabled || !modelId) return [];
    return this.voiceProfileService.listForRuntime(params.userId, params.tenantId, modelId);
  }

  async dispatchDramatiqJob(params: {
    jobId: string;
    tenantId: string;
    pipelineId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    language?: string;
    userId?: string;
    audioBucketName?: string;
    storage?: StorageDescriptor | null;
    /**
     * @deprecated TASK-861 — removed in R4. Tenant fallback pipeline the worker
     * re-runs on when the primary ASR fails; superseded by `resolvedSpec.fallback`.
     */
    fallbackPipelineId?: string;
    /**
     * TASK-861 — the gateway-resolved ASR spec. When present the worker
     * assembles the engine chain from it (no DB read) and `pipelineId` is the
     * spec's runtime key; the spec's own `fallback` block replaces
     * `fallbackPipelineId`. Sent as a KWARG (never positional) for the same
     * reason `storage` is.
     */
    resolvedSpec?: ResolvedAsrSpec;
  }): Promise<void> {
    const voiceProfiles = await this.resolveVoiceProfiles(params);
    const messageId = uuidv7();
    const redisMessageId = uuidv7(); // Required by Dramatiq protocol
    const message = {
      queue_name: 'stt_batch',
      actor_name: 'transcribe_file',
      args: [
        params.jobId,
        params.tenantId,
        params.pipelineId,
        params.audioUri,
        params.consultationId ?? null,
        params.mediaId ?? null,
        params.language ?? null,
        null,
        params.audioBucketName ?? 'hope-audio',
        params.userId ?? null,
      ],
      // Kwargs, never positional. The actor's positional tail is
      // (..., user_id, storage, fallback_pipeline_id), so appending either of
      // these positionally would force emitting the slots before it and would
      // silently shift on any future insertion upstream. Both are optional and
      // omitted entirely when absent.
      kwargs: {
        // Per-tenant storage descriptor — DEDICATED tenants only.
        ...(params.storage ? { storage: params.storage } : {}),
        // TASK-861 — the resolved spec carries its own fallback; the deprecated
        // pointer is sent only on the legacy pipeline path.
        ...(params.resolvedSpec ? { resolved_spec: params.resolvedSpec } : {}),
        ...(params.fallbackPipelineId && !params.resolvedSpec ? { fallback_pipeline_id: params.fallbackPipelineId } : {}),
        // TASK-887 — the job user's enrolled profiles for THIS agent's embedding model, so
        // the worker can label a matched speaker. Omitted entirely when there are none: the
        // worker treats absence as "diarize generically", and an empty list would say the
        // same thing in a second way.
        ...(voiceProfiles.length > 0 ? { voice_profiles: voiceProfiles } : {}),
      },
      options: {
        redis_message_id: redisMessageId,
      },
      message_id: messageId,
      message_timestamp: Date.now(),
    };

    const encoded = JSON.stringify(message);

    try {
      // Step 1: Store message payload in the messages hash
      // Key: dramatiq:stt_batch.msgs, Field: message_id, Value: encoded JSON
      await this.cacheService.hset(`${this.DRAMATIQ_QUEUE}.msgs`, messageId, encoded);

      // Step 2: Push message ID (not payload) to the queue list
      // Workers BRPOP this list to get message IDs
      await this.cacheService.rpush(this.DRAMATIQ_QUEUE, messageId);

      // Step 3: Notify Dramatiq workers that a new message is available
      await this.cacheService.publish(this.DRAMATIQ_EVENTS_CHANNEL, 'stt_batch');

      this.logger.log({
        message: 'Dispatched Dramatiq job',
        jobId: params.jobId,
        messageId,
        redisMessageId,
        queue: this.DRAMATIQ_QUEUE,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to dispatch Dramatiq job',
        jobId: params.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // TASK-992 FU-1 — snapshot what was just published, so `retryAndDispatch`
    // can re-publish it. This is the ONE place a batch message is produced, so
    // the snapshot cannot drift from the message it describes.
    //
    // AFTER the enqueue, and deliberately non-fatal: dispatch has never needed
    // the database, and making a transient write failure fail a job that is
    // already queued would be a worse bug than the one this closes. The cost of
    // losing the write is a job that cannot be retried later — which the retry
    // path refuses explicitly rather than papering over.
    try {
      await this.transcriptionJobService.recordDispatchEnvelope(params.jobId, {
        audioUri: params.audioUri,
        pipelineId: params.pipelineId,
        ...(params.consultationId ? { consultationId: params.consultationId } : {}),
        ...(params.mediaId ? { mediaId: params.mediaId } : {}),
        ...(params.language ? { language: params.language } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
        ...(params.audioBucketName ? { audioBucketName: params.audioBucketName } : {}),
        ...(params.fallbackPipelineId ? { fallbackPipelineId: params.fallbackPipelineId } : {}),
        hadStorageDescriptor: Boolean(params.storage),
      });
    } catch (error) {
      this.logger.warn({
        message: 'Dispatched, but failed to record the retry envelope — this job will refuse a later retry',
        jobId: params.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-992 FU-1 — retry a failed batch job by actually RE-PUBLISHING it.
   *
   * `TranscriptionJobService.retryJob` only flips the row back to `QUEUED`. The
   * batch plane is driven entirely by the `stt_batch` Dramatiq queue, so a row
   * with no message behind it is never claimed by anybody: the caller sees a
   * 200 and a job that sits at QUEUED forever, which from the outside is
   * indistinguishable from a backed-up queue. This closes that.
   *
   * It lives HERE, beside {@link dispatchDramatiqJob}, rather than in the job
   * service, for the reason the two could otherwise drift: one method builds
   * the message, the other rebuilds it, and a kwarg added to one would be
   * silently missing from the other. (It also cannot live in the job service —
   * the realtime service already depends on it, so the edge only goes one way.)
   *
   * Order matters. Everything fallible that does NOT touch the row happens
   * first — envelope read, storage re-resolution — so a refusal leaves the job
   * exactly as it was, still FAILED and still retryable once the cause is
   * fixed. Only then is the status flipped and the message published; if the
   * publish then fails, the job is failed back with `RETRY_DISPATCH_ERROR`
   * rather than left QUEUED with nothing behind it, which is the same
   * compensation the create path performs.
   */
  async retryAndDispatch(jobId: string, options: { ownerId: string }): Promise<TranscriptionJobResponse> {
    // 1. Creator-scoped read. Throws 404 for an unknown id AND for a
    //    same-tenant peer's job — no existence leak, same posture as
    //    `retryJobForOwner`, which runs the identical assertion in step 3.
    const context = await this.transcriptionJobService.getDispatchContextForOwner(options.ownerId, jobId);

    // 2. A row dispatched before FU-1 shipped has no envelope, and its
    //    `audioUri` exists nowhere else — the upload path derives it from a
    //    request filename that is long gone. Refusing is the only honest
    //    answer: flipping it to QUEUED would recreate the exact defect.
    const envelope: BatchDispatchEnvelope | null = context.envelope;
    if (!envelope?.audioUri) {
      throw new ConflictException({
        code: 'RETRY_ENVELOPE_MISSING',
        message:
          `Job ${jobId} cannot be retried: it carries no record of what was dispatched for it. ` +
          `Jobs created before this capability shipped are affected; submit the audio again as a new job.`,
      });
    }

    // 3. Re-resolve the storage descriptor LIVE. It is never snapshotted (it
    //    carries credentials), and resolving it fresh is also what lets a
    //    credential rotate between attempts. If one was in play and we cannot
    //    produce it now, refuse — dispatching without it sends the worker to
    //    its env-default backend, where the object is not.
    let storage: StorageDescriptor | null = null;
    if (envelope.hadStorageDescriptor) {
      storage = envelope.audioBucketName && this.blobStorage ? await this.blobStorage.resolveDescriptor(envelope.audioBucketName) : null;
      if (!storage) {
        throw new ServiceUnavailableException({
          code: 'RETRY_STORAGE_UNRESOLVED',
          message: `Job ${jobId} was dispatched against a tenant-specific storage backend that cannot be resolved right now.`,
        });
      }
    }

    // 4. Flip the row (creator-scoped again, inside), then publish.
    const retried = await this.transcriptionJobService.retryJobForOwner(options.ownerId, jobId);

    try {
      await this.dispatchDramatiqJob({
        jobId,
        tenantId: context.tenantId,
        pipelineId: envelope.pipelineId,
        audioUri: envelope.audioUri,
        consultationId: envelope.consultationId,
        mediaId: envelope.mediaId,
        language: envelope.language,
        userId: envelope.userId,
        audioBucketName: envelope.audioBucketName,
        storage,
        ...(envelope.fallbackPipelineId ? { fallbackPipelineId: envelope.fallbackPipelineId } : {}),
        // The spec snapshot stays on the ROW (TASK-861) — it is the
        // authoritative, reproducible copy, so the envelope never duplicates it.
        ...(context.resolvedSpec ? { resolvedSpec: context.resolvedSpec as unknown as ResolvedAsrSpec } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.transcriptionJobService.failJob(jobId, `Retry dispatch failed: ${message}`, 'RETRY_DISPATCH_ERROR').catch(() => undefined);
      throw error;
    }

    return retried;
  }
}
