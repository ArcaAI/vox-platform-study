import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobQueue, type QueueStats } from '@arcaai/domains';

@Injectable()
export class QueueAdminService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const queue = this.getQueue(queueName);
    const [isPaused, counts, workers] = await Promise.all([
      queue.isPaused(),
      queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
        'prioritized',
      ),
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
        paused: counts.paused ?? 0,
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

  async cleanQueue(
    queueName: string,
    status: 'completed' | 'failed',
    gracePeriodMs: number,
    limit = 1000,
  ): Promise<string[]> {
    const queue = this.getQueue(queueName);
    return queue.clean(gracePeriodMs, limit, status);
  }

  private getQueue(queueName: string): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queueName), {
      strict: false,
    });
  }
}
