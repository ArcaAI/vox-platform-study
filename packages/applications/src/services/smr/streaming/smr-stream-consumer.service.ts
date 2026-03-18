import { Injectable, Logger, OnModuleDestroy, Optional, Inject, MessageEvent } from '@nestjs/common';
import { Observable, Subject, finalize } from 'rxjs';
import Redis from 'ioredis';
import { IConfigService } from '../../baseServices/_meta/config';

export interface SmrStreamChunk {
    id: string;
    type: string;
    data: Record<string, unknown>;
}

/**
 * SmrStreamConsumerService
 *
 * Reads SMR V2 task chunks directly from Redis Streams:
 * - Stream key: `smr:stream:{taskId}` (matches Python TaskManager._STREAM_KEY_PREFIX)
 * - Each entry has a `data` field containing JSON-serialized StreamChunk
 * - StreamChunk has: `type` (string), `data` (dict)
 *
 * Uses a dedicated ioredis connection (separate from RedisCacheService)
 * to avoid blocking the main Redis client with XREAD calls.
 */
@Injectable()
export class SmrStreamConsumerService implements OnModuleDestroy {
    private readonly logger = new Logger(SmrStreamConsumerService.name);

    private readerRedis: Redis | null = null;
    private connected = false;

    private readonly activeSubscriptions = new Map<string, { abort: boolean }>();

    constructor(
        @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    ) {}

    async onModuleDestroy(): Promise<void> {
        await this.disconnect();
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        if (!this.configService?.isRedisConfigured()) {
            this.logger.warn({ message: 'Redis not configured — SMR stream consumer disabled' });
            return;
        }

        const config = this.configService.getRedisConfig();

        this.readerRedis = new Redis({
            host: config.host,
            port: config.port,
            password: config.password,
            maxRetriesPerRequest: null,
            lazyConnect: false,
        });

        this.connected = true;
        this.logger.log({ message: 'SMR stream consumer Redis connection established' });
    }

    async disconnect(): Promise<void> {
        for (const [, ctrl] of this.activeSubscriptions) {
            ctrl.abort = true;
        }
        this.activeSubscriptions.clear();

        if (this.readerRedis) {
            await this.readerRedis.quit().catch(() => {});
            this.readerRedis = null;
        }
        this.connected = false;
    }

    /**
     * Subscribe to SMR V2 task chunks via Redis Streams.
     * Returns an Observable that emits SSE-compatible MessageEvents.
     * Supports Last-Event-ID for resume.
     */
    subscribeToTaskChunks(taskId: string, lastEventId?: string): Observable<MessageEvent> {
        const subject = new Subject<MessageEvent>();
        const ctrl = { abort: false };
        this.activeSubscriptions.set(taskId, ctrl);

        const streamKey = `smr:stream:${taskId}`;
        const startId = lastEventId || '0-0';

        this.readChunkStream(streamKey, startId, taskId, subject, ctrl).catch((error) => {
            this.logger.error({
                message: 'Chunk stream reader error',
                taskId,
                error: error instanceof Error ? error.message : String(error),
            });
            subject.error(error);
        });

        return subject.asObservable().pipe(
            finalize(() => {
                ctrl.abort = true;
                this.activeSubscriptions.delete(taskId);
            }),
        );
    }

    unsubscribeFromTask(taskId: string): void {
        const ctrl = this.activeSubscriptions.get(taskId);
        if (ctrl) {
            ctrl.abort = true;
            this.activeSubscriptions.delete(taskId);
        }
    }

    private async readChunkStream(
        streamKey: string,
        startId: string,
        taskId: string,
        subject: Subject<MessageEvent>,
        ctrl: { abort: boolean },
    ): Promise<void> {
        if (!this.readerRedis) return;

        let lastId = startId;

        while (!ctrl.abort) {
            try {
                const result = await this.readerRedis.xread(
                    'COUNT', 100,
                    'BLOCK', 5000,
                    'STREAMS', streamKey, lastId,
                );

                if (!result || ctrl.abort) continue;

                for (const [, entries] of result) {
                    for (const [entryId, fields] of entries) {
                        lastId = entryId;

                        const fieldMap: Record<string, string> = {};
                        for (let i = 0; i < fields.length; i += 2) {
                            fieldMap[fields[i]] = fields[i + 1];
                        }

                        const rawData = fieldMap['data'];
                        if (!rawData) continue;

                        let parsed: { type?: string; data?: Record<string, unknown> };
                        try {
                            parsed = JSON.parse(rawData);
                        } catch {
                            continue;
                        }

                        const event: MessageEvent = {
                            data: JSON.stringify({
                                id: entryId,
                                type: parsed.type || 'chunk',
                                ...parsed.data,
                            }),
                            id: entryId,
                            type: parsed.type || 'chunk',
                        };

                        subject.next(event);

                        if (parsed.type === 'done' || parsed.type === 'error') {
                            subject.complete();
                            return;
                        }
                    }
                }
            } catch (error) {
                if (ctrl.abort) return;
                this.logger.warn({
                    message: 'XREAD error, retrying',
                    streamKey,
                    taskId,
                    error: error instanceof Error ? error.message : String(error),
                });
                await new Promise((r) => setTimeout(r, 500));
            }
        }

        subject.complete();
    }
}
