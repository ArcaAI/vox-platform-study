/**
 * @arcaai/vox — Global-admin ops-surface types (TASK-403).
 *
 * Wire shapes for the three OPERATIONS admin surfaces:
 * - Rate Limits  → `apps/api/src/modules/admin-rate-limit/` (TASK-316 substrate)
 * - Queues & Jobs → `apps/api/src/modules/queue-admin/` (TASK-250/336 substrate)
 * - Prisma Studio → `apps/api/src/modules/pstudio/pstudio-status.controller.ts`
 *
 * These mirror the API response DTOs / `@arcaai/domains` interfaces 1:1 — the
 * SDK adds no reshaping.
 */

// ---------------------------------------------------------------------------
// Rate Limits
// ---------------------------------------------------------------------------

export type RateLimitTierName = 'default' | 'strict' | 'heavy' | 'relaxed';

/** Where an effective value came from: DB override, code decorator, or static default. */
export type RateLimitValueSource = 'db' | 'code' | 'default';

export interface RateLimitTierPolicy {
  tier: RateLimitTierName;
  limit: number;
  /** Window length in milliseconds. */
  ttl: number;
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

export interface RateLimitRoutePolicy {
  /** Stable slug, e.g. `auth.login`. */
  routeId: string;
  controller: string;
  handler?: string;
  description: string;
  tier: RateLimitTierName;
  limit: number;
  ttl: number;
  enabled: boolean;
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

/** Full effective policy returned by every `/admin/rate-limit` read AND mutation. */
export interface RateLimitPolicy {
  /** Global kill-switch effective state. */
  enabled: boolean;
  enabledSource: 'db' | 'default';
  tiers: RateLimitTierPolicy[];
  routes: RateLimitRoutePolicy[];
}

export interface SetRateLimitTierInput {
  limit?: number;
  ttl?: number;
}

export interface SetRateLimitRouteInput {
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Queues & Jobs
// ---------------------------------------------------------------------------

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

export type JobStatusFilter = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

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
  /** PII-redacted by the server. */
  data: Record<string, unknown>;
  returnValue: unknown | null;
  stacktrace: string[];
  logs: string[];
  opts: JobOptions;
}

export interface PaginatedJobs {
  items: JobSummary[];
  total: number;
  /** Zero-based page index. */
  page: number;
  limit: number;
}

export interface ListJobsParams {
  /** Zero-based page index. */
  page?: number;
  limit?: number;
  status?: JobStatusFilter;
  jobName?: string;
}

export interface BulkJobActionResult {
  succeeded: number;
  failed: number;
}

export interface RedisHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** PING round-trip in ms (-1 when unreachable). */
  latencyMs: number;
  connectedClients: number;
  usedMemory: string;
  /** Server uptime in seconds. */
  uptime: number;
  version: string;
  queuesRegistered: number;
}

// ---------------------------------------------------------------------------
// Prisma Studio
// ---------------------------------------------------------------------------

export interface PrismaStudioStatus {
  /** Whether the dev-only Studio shell (`GET /admin/pstudio`) is served in this environment. */
  enabled: boolean;
}
