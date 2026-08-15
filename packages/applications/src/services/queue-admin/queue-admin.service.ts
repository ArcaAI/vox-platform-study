import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobQueue, type QueueStats, type RedisHealthInfo } from '@arcaai/domains';

/** PING round-trips at or above this are reported as `degraded`. */
const REDIS_DEGRADED_LATENCY_MS = 250;

@Injectable()
export class QueueAdminService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const queue = this.getQueue(queueName);
    const [isPaused, counts, workers] = await Promise.all([
      queue.isPaused(),
      queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
      queue.getWorkers(),
    ]);

    return {
      name: queueName,
      isPaused,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        // BullMQ 6 dropped the paused job type; paused queues keep jobs in waiting.
        paused: 0,
        prioritized: counts.prioritized ?? 0,
      },
      workerCount: workers.length,
    };
  }

  async getAllQueueStats(): Promise<QueueStats[]> {
    const queueNames = Object.values(JobQueue);
    return Promise.all(queueNames.map((name) => this.getQueueStats(name)));
  }

  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.pause();
  }

  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.resume();
  }

  async cleanQueue(queueName: string, status: 'completed' | 'failed', gracePeriodMs: number, limit = 1000): Promise<string[]> {
    const queue = this.getQueue(queueName);
    return queue.clean(gracePeriodMs, limit, status);
  }

  /**
   * Probe the shared BullMQ Redis connection for the Queues & Jobs surface.
   * Uses the first registered queue's Redis backend client: INFO for latency
   * and server stats. Never throws — connection errors are reported as
   * `unhealthy` so the admin surface can always render.
   */
  async getRedisHealth(): Promise<RedisHealthInfo> {
    const queuesRegistered = Object.values(JobQueue).length;
    try {
      const queue = this.getQueue(Object.values(JobQueue)[0]);
      const client = await queue.getBackend().client;

      const pingStart = Date.now();
      const info = parseRedisInfo(await client.info());
      const latencyMs = Date.now() - pingStart;

      return {
        status: latencyMs >= REDIS_DEGRADED_LATENCY_MS ? 'degraded' : 'healthy',
        latencyMs,
        connectedClients: Number(info.connected_clients ?? 0) || 0,
        usedMemory: info.used_memory_human ?? 'unknown',
        uptime: Number(info.uptime_in_seconds ?? 0) || 0,
        version: info.redis_version ?? 'unknown',
        queuesRegistered,
      };
    } catch {
      return {
        status: 'unhealthy',
        latencyMs: -1,
        connectedClients: 0,
        usedMemory: 'unknown',
        uptime: 0,
        version: 'unknown',
        queuesRegistered,
      };
    }
  }

  private getQueue(queueName: string): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queueName), {
      strict: false,
    });
  }
}

/** Parse `redis-cli INFO`-style `key:value` lines into a lookup map. */
function parseRedisInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0 && !line.startsWith('#')) {
      result[line.slice(0, idx)] = line.slice(idx + 1).trim();
    }
  }
  return result;
}
