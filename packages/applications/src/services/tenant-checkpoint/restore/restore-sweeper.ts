/**
 * Stale-restore sweeper (every minute). A restore whose worker died leaves the tenant locked; the
 * sweeper ends it so the tenant is writable again:
 *   - PENDING, never picked up, older than 15 minutes          → FAILED(WORKER_LOST)
 *   - non-terminal, heartbeat older than 2 minutes and no live
 *     reconcile connection (`application_name` probe)           → FAILED(WORKER_LOST)
 *   - non-terminal, lock held longer than maxLockMinutes        → FAILED(LOCK_TIMEOUT); a live
 *     reconcile connection is cancelled, and its compare-and-set fails anyway
 * A POST_COMMIT row is COMMITTED data and is never marked FAILED: past either limit it is released
 * as COMPLETED_WITH_WARNINGS (LOCK_TIMEOUT_POST_COMMIT / WORKER_LOST_POST_COMMIT).
 * A dead worker's transaction was already rolled back by Postgres when its connection dropped.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  generateId,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantCheckpointRestoreRepository,
  TenantCheckpointRestoreStatus,
  type TenantCheckpointRestoreEntity,
} from '@arcaai/domains';

import { TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY } from '../../settings-registry/descriptors/tenant-checkpoint.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { ITenantLockService, type CheckpointFailureReason } from '../contracts';
import {
  CHECKPOINT_RESTORE_DB,
  patchRestore,
  realClock,
  RESTORE_CLOCK,
  restoreBackendName,
  TERMINAL_RESTORE_STATUSES,
  type RestoreClock,
  type RestoreDb,
} from './restore-row';

export const RESTORE_HEARTBEAT_STALE_MS = 2 * 60_000;
/** A PENDING restore no worker picked up within this long is lost (its job never ran). */
export const RESTORE_PENDING_STALE_MS = 15 * 60_000;
const DEFAULT_MAX_LOCK_MINUTES = 60;
/** The seeded system user — the sweeper acts on nobody's behalf. */
const SWEEPER_ACTOR = '60000000-0000-0000-0000-000000000000';

@Injectable()
export class CheckpointRestoreSweeper {
  private readonly logger = new Logger(CheckpointRestoreSweeper.name);
  private running = false;

  constructor(
    private readonly restores: TenantCheckpointRestoreRepository,
    @Inject(ITenantLockService) private readonly lock: ITenantLockService,
    private readonly settings: TenantSettingsService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(RESTORE_CLOCK) private readonly clock: RestoreClock = realClock,
    @Optional() @Inject(CHECKPOINT_RESTORE_DB) private readonly db?: RestoreDb,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'tenant-checkpoint-restore-sweeper' })
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.clock.now();
      const active = await this.restores.findAll({
        where: { resourceStatus: { not: ResourceStatusType.DELETED }, status: { notIn: TERMINAL_RESTORE_STATUSES } } as never,
      });
      let ended = 0;
      for (const row of active) {
        const reason = await this.verdict(row, now);
        if (reason && (await this.end(row.id, reason, now))) ended++;
      }
      return ended;
    } catch (error) {
      this.logger.error({ message: 'Restore sweep failed', error: error instanceof Error ? error.name : 'Error' });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async verdict(row: TenantCheckpointRestoreEntity, now: number): Promise<CheckpointFailureReason | null> {
    if (row.status === TenantCheckpointRestoreStatus.PENDING && !row.heartbeatAt && !row.lockAcquiredAt) {
      return row.createdAt && now - row.createdAt.getTime() > RESTORE_PENDING_STALE_MS ? 'WORKER_LOST' : null;
    }
    if (row.lockAcquiredAt) {
      const max = this.maxLockMinutes(row.tenantId) * 60_000;
      if (now - row.lockAcquiredAt.getTime() > max) return 'LOCK_TIMEOUT';
    }
    if (row.heartbeatAt && now - row.heartbeatAt.getTime() > RESTORE_HEARTBEAT_STALE_MS && !(await this.backendAlive(row.id))) return 'WORKER_LOST';
    return null;
  }

  /** The runner pauses its heartbeat inside the reconcile transaction; its connection is the liveness signal then. */
  private async backendAlive(restoreId: string): Promise<boolean> {
    if (!this.db) return false;
    try {
      const [{ n }] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [restoreBackendName(restoreId)]);
      return n > 0;
    } catch (error) {
      // An unanswerable probe must not fail a live restore; LOCK_TIMEOUT still bounds it.
      this.logger.warn({ message: 'Restore liveness probe failed', restoreId, error: error instanceof Error ? error.name : 'Error' });
      return true;
    }
  }

  /** Best effort: roll back a live reconcile transaction the sweeper just ended. */
  private async cancelBackend(restoreId: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [restoreBackendName(restoreId)]);
    } catch (error) {
      this.logger.warn({ message: 'Could not cancel the reconcile of an ended restore', restoreId, error: error instanceof Error ? error.name : 'Error' });
    }
  }

  private maxLockMinutes(tenantId: string): number {
    try {
      const v = this.settings.resolve<number>(TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY, tenantId).value;
      return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_LOCK_MINUTES;
    } catch {
      return DEFAULT_MAX_LOCK_MINUTES;
    }
  }

  private async end(id: string, reason: CheckpointFailureReason, now: number): Promise<boolean> {
    const at = new Date(now);
    let tenantId: string | null = null;
    let status: TenantCheckpointRestoreStatus = TenantCheckpointRestoreStatus.FAILED;
    let wasReconciling = false;
    const written = await patchRestore(this.restores, id, (row) => {
      if (TERMINAL_RESTORE_STATUSES.includes(row.status)) return false;
      tenantId = row.tenantId;
      if (row.status === TenantCheckpointRestoreStatus.POST_COMMIT) {
        // The data is committed: release the lock, never call it FAILED.
        status = TenantCheckpointRestoreStatus.COMPLETED_WITH_WARNINGS;
        const prior = Array.isArray(row.warnings) ? (row.warnings as unknown[]) : [];
        const code = reason === 'LOCK_TIMEOUT' ? 'LOCK_TIMEOUT_POST_COMMIT' : 'WORKER_LOST_POST_COMMIT';
        const message =
          reason === 'LOCK_TIMEOUT'
            ? 'The restore was committed; its post-commit steps ran past the lock limit and the lock was released'
            : 'The restore was committed; its worker stopped during the post-commit steps';
        row.warnings = [...prior, { code, message }] as never;
      } else {
        status = TenantCheckpointRestoreStatus.FAILED;
        wasReconciling = row.status === TenantCheckpointRestoreStatus.RECONCILING;
        row.failureReason = reason;
        row.failureDetail = reason === 'LOCK_TIMEOUT' ? 'The restore held the tenant lock past the allowed time' : 'The restore worker stopped responding';
      }
      row.status = status;
      row.lockReleasedAt = at;
      row.finishedAt = at;
    });
    if (!written || !tenantId) return false;
    this.logger.warn({ message: 'Stale tenant restore ended', restoreId: id, reason, status });
    if (wasReconciling) await this.cancelBackend(id);
    await this.lock.publishChange(tenantId);
    this.eventEmitter.emit(SysEventType.ResourceUpdated, {
      id: generateId(),
      type: SysEventType.ResourceUpdated,
      resourceType: ResourceType.TenantCheckpointRestore,
      resourceId: id,
      tenantId,
      responsibleEntityId: SWEEPER_ACTOR,
      forceAuditLog: true,
      data: { action: 'tenant-restore', status, ...(status === TenantCheckpointRestoreStatus.FAILED ? { failureReason: reason } : { warning: reason }) },
    });
    return true;
  }
}
