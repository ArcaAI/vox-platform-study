export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  prioritized: number;
}

export interface QueueStats {
  name: string;
  isPaused: boolean;
  counts: QueueJobCounts;
  workerCount: number;
}

export type QueueEventType = 'job:completed' | 'job:failed' | 'job:stalled' | 'job:active' | 'job:waiting' | 'job:progress';

export interface QueueEventPayload {
  type: QueueEventType;
  queueName: string;
  jobId: string;
  timestamp: number;
  failedReason?: string;
  returnValue?: string;
  progress?: number | object;
}

export interface JobSummary {
  id: string;
  name: string;
  queueName: string;
  status: string;
  progress: number | null;
  attempts: number;
  maxAttempts: number;
  delay: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  parentId: string | null;
}

export interface JobOptions {
  attempts: number;
  delay: number;
  backoff: { type: string; delay: number } | null;
  priority: number;
  removeOnComplete: boolean | number;
  removeOnFail: boolean | number;
}

export interface JobDetail extends JobSummary {
  data: Record<string, unknown>;
  returnValue: unknown | null;
  stacktrace: string[];
  logs: string[];
  opts: JobOptions;
}

export interface SchedulerInfo {
  name: string;
  type: 'cron' | 'interval' | 'timeout';
  source: 'static' | 'dynamic';
  cronExpression: string | null;
  intervalMs: number | null;
  running: boolean;
  lastExecution: string | null;
  nextExecution: string | null;
  timeZone: string | null;
  settingsKey: string | null;
}

export interface RedisHealthInfo {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  connectedClients: number;
  usedMemory: string;
  uptime: number;
  version: string;
  queuesRegistered: number;
}

export interface QueueMetrics {
  queueName: string;
  period: string;
  completedRate: number;
  failedRate: number;
  avgProcessingTimeMs: number;
  avgWaitTimeMs: number;
}
