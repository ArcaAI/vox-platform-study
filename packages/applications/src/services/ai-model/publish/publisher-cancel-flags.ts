/**
 * TASK-1023 D-C — the cooperative cancel signal between the gateway (which
 * SETS it for a running job) and the model-publisher worker (which POLLS it at
 * every heartbeat and file boundary). One Redis key per job,
 * `model-publisher:cancel:<jobId>`, on the SAME connection the
 * `DownloadAiModel` queue uses — so both processes already reach it and no new
 * config is needed. The key carries a TTL: a flag nobody consumed (the job
 * finished first, the worker died) cleans itself up.
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { Provider } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobQueue } from '@arcaai/domains';

export const PUBLISHER_CANCEL_KEY_PREFIX = 'model-publisher:cancel:';

/** Longer than any single download's life; a stale flag must not outlive a re-used id (UUIDv7: never re-used). */
export const PUBLISHER_CANCEL_TTL_SECONDS = 24 * 60 * 60;

export function publisherCancelKey(jobId: string): string {
  return `${PUBLISHER_CANCEL_KEY_PREFIX}${jobId}`;
}

export interface PublisherCancelFlags {
  request(jobId: string): Promise<void>;
  isRequested(jobId: string): Promise<boolean>;
  clear(jobId: string): Promise<void>;
}

export const PUBLISHER_CANCEL_FLAGS = Symbol('PUBLISHER_CANCEL_FLAGS');

/** The slice of an ioredis client the flags use. */
export interface CancelFlagRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export class RedisPublisherCancelFlags implements PublisherCancelFlags {
  constructor(private readonly client: () => Promise<CancelFlagRedis>) {}

  async request(jobId: string): Promise<void> {
    await (await this.client()).set(publisherCancelKey(jobId), '1', 'EX', PUBLISHER_CANCEL_TTL_SECONDS);
  }

  async isRequested(jobId: string): Promise<boolean> {
    return (await (await this.client()).exists(publisherCancelKey(jobId))) > 0;
  }

  async clear(jobId: string): Promise<void> {
    await (await this.client()).del(publisherCancelKey(jobId));
  }
}

/** Provider for BOTH halves: the flags ride the `DownloadAiModel` queue's own Redis connection. */
export const publisherCancelFlagsProvider: Provider = {
  provide: PUBLISHER_CANCEL_FLAGS,
  // BullMQ 6: the raw Redis client is the Redis backend's escape hatch.
  useFactory: (queue: Queue) => new RedisPublisherCancelFlags(async () => (await queue.getBackend().client) as unknown as CancelFlagRedis),
  inject: [getQueueToken(JobQueue.DownloadAiModel)],
};
