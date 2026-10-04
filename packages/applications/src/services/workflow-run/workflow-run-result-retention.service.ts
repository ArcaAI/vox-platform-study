import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WorkflowRunEntity, WorkflowRunRepository } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY } from '../settings-registry/descriptors/workflow-runs.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import type { ExpiredRunResult } from './run-result';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Rows read per page. Bounded so one purge never holds a large result set in memory. */
export const WORKFLOW_RUN_RESULT_PURGE_PAGE = 500;
/** Hard cap on pages per run — a backlog larger than this finishes on the next day's run. */
const MAX_PAGES = 200;
export const WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY = 'workflow-run-result-retention:lock';
const PURGE_LOCK_TTL_SECONDS = 30 * 60;

/** The result kinds a purge may expire — a tombstone is never re-expired. */
const LIVE_RESULT = { OR: [{ resultRef: { path: ['kind'], equals: 'inline' } }, { resultRef: { path: ['kind'], equals: 'ref' } }] };

/**
 * `WorkflowRunResultRetentionService` — TASK-1038, owner decision OD-25: a finished run's
 * delivered result is kept `workflowRuns.resultRetentionDays` (30 by default, tenant-overridable)
 * and then EXPIRED.
 *
 * Expiring REPLACES `WorkflowRun.resultRef` with an `expired` tombstone rather than deleting the
 * row or nulling the column: the run's status, counts and timings are an audit trail that outlives
 * the output, and the result route can then answer "this existed and is gone" (410) instead of
 * "there never was one" (204). A claim-checked result's OBJECT is left to the bucket's own
 * lifecycle: object keys are content-addressed and may be shared, so deleting one here could
 * break another run's reference.
 *
 * The precedent is the composed-prompt purge (TASK-1035, `ComposedPromptService.purgeExpired`):
 * a daily cron, one node at a time behind a Redis lock, every step idempotent (a lost lock costs
 * duplicated work, never a wrong result), per-tenant windows. Unlike that purge this one has no
 * tenant enumeration of its own: it walks the candidate rows in keyset order — the shortest
 * window any tenant may set is one day, so only results that ended more than a day ago are ever
 * read — and applies each row's own tenant window. A row the completion watcher rewrote meanwhile
 * fails its version check and is simply left for tomorrow.
 *
 * Runs outside any request, so the tenant-scope extension sees no CLS context and reads across
 * tenants — the same posture the trajectory and composed-prompt purges rely on.
 */
@Injectable()
export class WorkflowRunResultRetentionService {
  private readonly logger = new Logger(WorkflowRunResultRetentionService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly repository: WorkflowRunRepository,
    @Optional() private readonly settings?: TenantSettingsService,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {}

  @Cron('45 4 * * *', { name: 'workflow-run-result-retention' })
  async retention(): Promise<void> {
    await this.purgeExpired().catch((error) =>
      this.logger.error({ message: 'Workflow-run result retention purge failed', error: error instanceof Error ? error.name : 'unknown' }),
    );
  }

  async purgeExpired(): Promise<{ scanned: number; expired: number }> {
    if (!(await this.acquireLock())) return { scanned: 0, expired: 0 };
    try {
      const now = this.now();
      const oldestPossibleWindow = new Date(now.getTime() - MS_PER_DAY);
      const windows = new Map<string, number>();
      let cursor: { endedAt: Date; id: string } | null = null;
      let scanned = 0;
      let expired = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        const conditions: Record<string, unknown>[] = [{ endedAt: { lt: oldestPossibleWindow } }, LIVE_RESULT];
        if (cursor) conditions.push({ OR: [{ endedAt: { gt: cursor.endedAt } }, { endedAt: cursor.endedAt, id: { gt: cursor.id } }] });
        const rows: WorkflowRunEntity[] = await this.repository.findAll({
          where: { AND: conditions } as never,
          sort: [{ endedAt: 'asc' }, { id: 'asc' }],
          limit: WORKFLOW_RUN_RESULT_PURGE_PAGE,
        });
        scanned += rows.length;

        for (const row of rows) {
          const days = windows.get(row.tenantId) ?? this.retentionDays(row.tenantId);
          windows.set(row.tenantId, days);
          if (!row.endedAt || row.endedAt.getTime() >= now.getTime() - days * MS_PER_DAY) continue;
          if (await this.expire(row, now)) expired += 1;
        }

        if (rows.length < WORKFLOW_RUN_RESULT_PURGE_PAGE) break;
        const last = rows[rows.length - 1];
        cursor = { endedAt: last.endedAt as Date, id: last.id };
      }

      if (expired > 0) this.logger.log({ message: 'Workflow-run results expired', scanned, expired });
      return { scanned, expired };
    } finally {
      await this.releaseLock();
    }
  }

  private async expire(row: WorkflowRunEntity, now: Date): Promise<boolean> {
    const tombstone: ExpiredRunResult = { kind: 'expired', expiredAt: now.toISOString() };
    row.resultRef = tombstone as never;
    try {
      await this.repository.updateWithVersion(row.id, row, row.version);
      return true;
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) return false; // rewritten meanwhile — tomorrow's run
      this.logger.error({ message: 'Workflow-run result could not be expired', runRowId: row.id, tenantId: row.tenantId, error: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  }

  private retentionDays(tenantId: string): number {
    try {
      const value = this.settings?.resolve<number>(WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY, tenantId).value;
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.resultRetentionDays;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.resultRetentionDays;
    }
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])",
        1,
        WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY,
        'held',
        PURGE_LOCK_TTL_SECONDS,
      );
      return reply === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY).catch(() => undefined);
  }
}
