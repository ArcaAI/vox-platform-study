/**
 * Checkpoint housekeeping, in the checkpoint worker:
 *
 * - every 5 min — a RUNNING checkpoint whose heartbeat is older than 2 min lost its worker:
 *   `FAILED(WORKER_LOST)`; an UPLOADING checkpoint idle for 24 h is abandoned: its multipart
 *   upload is aborted and the row `CANCELLED`.
 * - daily — retention, under a cross-replica Redis lock: READY checkpoints past `expiresAt` or
 *   beyond the tenant's `maxRetained` (newest first) are deleted (object, then soft-deleted row).
 *   Never deleted automatically: a tenant's newest READY checkpoint, and any SAFETY checkpoint
 *   younger than 7 days.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import {
  ResourceType,
  SysEventType,
  TenantCheckpointKind,
  TenantCheckpointRepository,
  TenantCheckpointStatus,
  type TenantCheckpointEntity,
} from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import { TENANT_CHECKPOINT_MAX_RETAINED_KEY } from '../../settings-registry/descriptors/tenant-checkpoint.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { ICheckpointStore } from '../contracts';
import { patchCheckpoint } from './checkpoint-row';

export const RETENTION_LOCK_KEY = 'tenant-checkpoint-retention:lock';
const RETENTION_LOCK_TTL_SECONDS = 30 * 60;
const STALE_HEARTBEAT_MS = 2 * 60_000;
const IDLE_UPLOAD_MS = 24 * 60 * 60_000;
const SAFETY_PROTECTED_MS = 7 * 24 * 60 * 60_000;

@Injectable()
export class CheckpointSweeper extends BaseService {
  private readonly logger = new Logger(CheckpointSweeper.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly checkpoints: TenantCheckpointRepository,
    @Inject(ICheckpointStore) private readonly store: ICheckpointStore,
    private readonly settings: TenantSettingsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantCheckpoint);
  }

  @Cron('*/5 * * * *', { name: 'tenant-checkpoint-sweep' })
  async sweep(): Promise<void> {
    await this.sweepStaleExports().catch((error) => this.logger.error({ message: 'Stale checkpoint sweep failed', error: errorName(error) }));
    await this.sweepIdleUploads().catch((error) => this.logger.error({ message: 'Idle checkpoint upload sweep failed', error: errorName(error) }));
  }

  @Cron('30 3 * * *', { name: 'tenant-checkpoint-retention' })
  async retention(): Promise<void> {
    await this.sweepRetention().catch((error) => this.logger.error({ message: 'Checkpoint retention sweep failed', error: errorName(error) }));
  }

  async sweepStaleExports(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - STALE_HEARTBEAT_MS);
    // Cross-tenant scan (unscoped read); each row is failed in its own tenant session.
    for (const stale of await this.checkpoints.findStale(cutoff)) {
      await this.asTenant(stale.tenantId, async () => {
        const failed = await patchCheckpoint(this.checkpoints, stale.id, (row) => {
          if (row.status !== TenantCheckpointStatus.RUNNING || !row.heartbeatAt || row.heartbeatAt >= cutoff) return false;
          row.status = TenantCheckpointStatus.FAILED;
          row.failureReason = 'WORKER_LOST';
          row.failureDetail = 'The checkpoint worker stopped reporting progress; the job was abandoned.';
          row.finishedAt = this.now();
        });
        if (!failed) return;
        // An unfinished upload never became an object; deleting the key is the idempotent cleanup.
        if (failed.objectKey) {
          await this.store
            .delete(failed.objectKey)
            .catch((error) =>
              this.logger.warn({ message: 'Deleting an abandoned checkpoint object failed', checkpointId: stale.id, error: errorName(error) }),
            );
        }
        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
          resourceId: stale.id,
          data: { status: TenantCheckpointStatus.FAILED, failureReason: 'WORKER_LOST' },
        });
      });
    }
  }

  async sweepIdleUploads(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - IDLE_UPLOAD_MS);
    // Cross-tenant scan: the repository's sanctioned unscoped read; each row is handled in its own tenant session.
    const idle = await this.checkpoints.findIdleUploads(cutoff);
    for (const upload of idle) {
      await this.asTenant(upload.tenantId, async () => {
        if (upload.uploadId && upload.objectKey) {
          await this.store
            .abortUpload(upload.objectKey, upload.uploadId)
            .catch((error) =>
              this.logger.warn({ message: 'Aborting an idle checkpoint upload failed', checkpointId: upload.id, error: errorName(error) }),
            );
        }
        const cancelled = await patchCheckpoint(this.checkpoints, upload.id, (row) => {
          if (row.status !== TenantCheckpointStatus.UPLOADING || row.updatedAt >= cutoff) return false;
          row.status = TenantCheckpointStatus.CANCELLED;
          row.uploadId = null;
          row.finishedAt = this.now();
        });
        if (!cancelled) return;
        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
          resourceId: upload.id,
          data: { status: TenantCheckpointStatus.CANCELLED, reason: 'upload-idle' },
        });
      });
    }
  }

  async sweepRetention(): Promise<void> {
    if (!(await this.acquireLock())) {
      this.logger.log({ message: 'Checkpoint retention skipped: another node holds the lock' });
      return;
    }
    try {
      // Cross-tenant scan (unscoped read); each tenant's deletions run in that tenant's session.
      const ready = await this.checkpoints.findReadyAnyTenant();
      const byTenant = new Map<string, TenantCheckpointEntity[]>();
      for (const row of ready) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);
      for (const [tenantId, rows] of byTenant) {
        await this.asTenant(tenantId, () => this.retainTenant(tenantId, rows)).catch((error) =>
          this.logger.error({ message: 'Checkpoint retention failed for a tenant', tenantId, error: errorName(error) }),
        );
      }
    } finally {
      await this.releaseLock();
    }
  }

  /** The READY rows `retention` would delete for one tenant (newest first ordering decides `maxRetained`). */
  retentionVictims(tenantId: string, rows: readonly TenantCheckpointEntity[]): TenantCheckpointEntity[] {
    const now = this.now().getTime();
    const maxRetained = this.settings.resolve<number>(TENANT_CHECKPOINT_MAX_RETAINED_KEY, tenantId).value;
    const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : 1));
    return sorted.filter((row, index) => {
      if (index === 0) return false; // the newest READY checkpoint is never auto-deleted
      if (row.kind === TenantCheckpointKind.SAFETY && now - row.createdAt.getTime() < SAFETY_PROTECTED_MS) return false;
      const expired = row.expiresAt != null && row.expiresAt.getTime() < now;
      return expired || index >= maxRetained;
    });
  }

  private async retainTenant(tenantId: string, rows: TenantCheckpointEntity[]): Promise<void> {
    for (const victim of this.retentionVictims(tenantId, rows)) {
      try {
        if (victim.objectKey) await this.store.delete(victim.objectKey);
        await this.checkpoints.softDelete(victim.id);
        this.broadcastSysEvent(SysEventType.ResourceDeleted, {
          resourceId: victim.id,
          data: { reason: 'retention', kind: victim.kind, createdAt: victim.createdAt.toISOString() },
        });
      } catch (error) {
        this.logger.error({ message: 'Deleting an expired checkpoint failed', checkpointId: victim.id, error: errorName(error) });
      }
    }
  }

  private async asTenant(tenantId: string, work: () => Promise<void>): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId, kind: 'tenant-checkpoint-sweeper' }) as never);
      try {
        await work();
      } catch (error) {
        this.logger.error({ message: 'Checkpoint sweep step failed', tenantId, error: errorName(error) });
      }
    });
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])",
        1,
        RETENTION_LOCK_KEY,
        'held',
        RETENTION_LOCK_TTL_SECONDS,
      );
      return reply === 'OK';
    } catch (error) {
      // Every step is idempotent, so an overlapping run is wasteful, not harmful.
      this.logger.warn({ message: 'Checkpoint retention lock unavailable; running without it', error: errorName(error) });
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    // swallow-ok: the retention lock has a TTL; a failed release only delays the next sweep
    await this.redis.del(RETENTION_LOCK_KEY).catch(() => undefined);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
