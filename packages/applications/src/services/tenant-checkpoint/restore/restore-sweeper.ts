/**
 * Stale-restore sweeper (every minute). A restore whose worker died leaves the tenant locked; the
 * sweeper ends it so the tenant is writable again:
 *   - non-terminal, heartbeat older than 2 minutes         → FAILED(WORKER_LOST)
 *   - non-terminal, lock held longer than maxLockMinutes   → FAILED(LOCK_TIMEOUT)
 * A dead worker's transaction was already rolled back by Postgres when its connection dropped; a
 * live-but-overdue runner re-checks its row right before COMMIT and aborts once the row is ended.
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
import { patchRestore, realClock, RESTORE_CLOCK, TERMINAL_RESTORE_STATUSES, type RestoreClock } from './restore-row';

export const RESTORE_HEARTBEAT_STALE_MS = 2 * 60_000;
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
        const reason = this.verdict(row, now);
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

  private verdict(row: TenantCheckpointRestoreEntity, now: number): CheckpointFailureReason | null {
    if (row.lockAcquiredAt) {
      const max = this.maxLockMinutes(row.tenantId) * 60_000;
      if (now - row.lockAcquiredAt.getTime() > max) return 'LOCK_TIMEOUT';
    }
    if (row.heartbeatAt && now - row.heartbeatAt.getTime() > RESTORE_HEARTBEAT_STALE_MS) return 'WORKER_LOST';
    return null;
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
    const written = await patchRestore(this.restores, id, (row) => {
      if (TERMINAL_RESTORE_STATUSES.includes(row.status)) return false;
      tenantId = row.tenantId;
      row.status = TenantCheckpointRestoreStatus.FAILED;
      row.failureReason = reason;
      row.failureDetail = reason === 'LOCK_TIMEOUT' ? 'The restore held the tenant lock past the allowed time' : 'The restore worker stopped responding';
      row.lockReleasedAt = at;
      row.finishedAt = at;
    });
    if (!written || !tenantId) return false;
    this.logger.warn({ message: 'Stale tenant restore ended', restoreId: id, reason });
    await this.lock.publishChange(tenantId);
    this.eventEmitter.emit(SysEventType.ResourceUpdated, {
      id: generateId(),
      type: SysEventType.ResourceUpdated,
      resourceType: ResourceType.TenantCheckpointRestore,
      resourceId: id,
      tenantId,
      responsibleEntityId: SWEEPER_ACTOR,
      forceAuditLog: true,
      data: { action: 'tenant-restore', status: TenantCheckpointRestoreStatus.FAILED, failureReason: reason },
    });
    return true;
  }
}
