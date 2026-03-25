import { Inject, Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Observable, finalize, map, takeWhile } from 'rxjs';
import { uuidv7 } from 'uuidv7';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import { TranscriptionJobService } from '../job/transcriptionJob.service';
import {
    TranscriptionEvent,
    TranscriptionEventType,
} from './dto';
import { ITranscriptionRealtimeService } from './ITranscriptionRealtimeService';
import { RedisSubscriberService } from './redisSubscriber.service';

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
            language: params.language,
            codeSwitching: params.codeSwitching,
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
            this.transcriptionJobService.getById(id).then(async (job) => {
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
            }).catch((error) => {
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
    private buildSseStream(
        jobId: string,
        channel: string,
        redisMessages$: Observable<string>,
    ): Observable<MessageEvent> {
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
     * Emit a transcript event to the SSE stream for a given job.
     */
    async emitTranscriptEvent(jobId: string, payload: {
        type: string;
        text: string;
        isFinal: boolean;
        speaker?: string;
        speakerId?: string;
        speakerLabel?: string;
        speakerConfidence?: number;
    }): Promise<void> {
        const channel = `${this.CHANNEL_PREFIX}${jobId}`;
        const event: TranscriptionEvent = {
            type: TranscriptionEventType.CHUNK,
            data: {
                jobId,
                chunkIndex: 0,
                text: payload.text,
                startTime: 0,
                endTime: 0,
                isFinal: payload.isFinal,
                ...(payload.speaker ? { speaker: payload.speaker } : {}),
                ...(payload.speakerId ? { speakerId: payload.speakerId } : {}),
                ...(payload.speakerLabel ? { speakerLabel: payload.speakerLabel } : {}),
                ...(typeof payload.speakerConfidence === 'number'
                    ? { speakerConfidence: payload.speakerConfidence }
                    : {}),
            },
        };
        await this.cacheService.publish(channel, JSON.stringify(event));
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
    async dispatchDramatiqJob(params: {
        jobId: string;
        tenantId: string;
        pipelineId: string;
        audioUri: string;
        consultationId?: string;
        mediaId?: string;
        language?: string;
        codeSwitching?: boolean;
    }): Promise<void> {
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
                params.codeSwitching ?? null,
            ],
            kwargs: {},
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
            await this.cacheService.hset(
                `${this.DRAMATIQ_QUEUE}.msgs`,
                messageId,
                encoded,
            );

            // Step 2: Push message ID (not payload) to the queue list
            // Workers BRPOP this list to get message IDs
            await this.cacheService.rpush(
                this.DRAMATIQ_QUEUE,
                messageId,
            );

            // Step 3: Notify Dramatiq workers that a new message is available
            await this.cacheService.publish(
                this.DRAMATIQ_EVENTS_CHANNEL,
                'stt_batch',
            );

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
    }
}
