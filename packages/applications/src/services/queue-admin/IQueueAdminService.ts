import type { QueueStats, RedisHealthInfo } from '@arcaai/domains';

export interface IQueueAdminService {
  getQueueStats(queueName: string): Promise<QueueStats>;
  getAllQueueStats(): Promise<QueueStats[]>;
  pauseQueue(queueName: string): Promise<void>;
  resumeQueue(queueName: string): Promise<void>;
  cleanQueue(queueName: string, status: 'completed' | 'failed', gracePeriodMs: number, limit?: number): Promise<string[]>;
  getRedisHealth(): Promise<RedisHealthInfo>;
}
export const IQueueAdminService = Symbol('IQueueAdminService');
