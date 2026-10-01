/**
 * The restore worker: lock → safety checkpoint → verify → media → reconcile (ONE transaction) →
 * post-commit → settle → unlock. The `TenantCheckpointRestore` row is the lock and the durable job
 * state; a heartbeat keeps it alive every 15 s so the sweeper can tell a dead worker from a slow one.
 *
 * Failure before the commit: the transaction rolls back, the lock is released, the row ends FAILED
 * and the tenant's data is exactly what it was. Failure after the commit: the data stays restored
 * and the row ends COMPLETED_WITH_WARNINGS.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { isDeepStrictEqual } from 'node:util';
import {
  ResourceType,
  SysEventType,
  TenantCheckpointFactory,
  TenantCheckpointKind,
  TenantCheckpointRepository,
  TenantCheckpointRestoreRepository,
  TenantCheckpointRestoreStatus,
  TenantCheckpointStatus,
  type TenantCheckpointRestoreEntity,
} from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { openArchive, verifyArchive } from '../archive';
import {
  CheckpointError,
  ICheckpointExportRunner,
  ICheckpointSealing,
  ICheckpointStore,
  ITenantLockService,
  type RestorableCategory,
  type RestoreWarning,
  type VerifiedArchive,
} from '../contracts';
import { CheckpointMediaRestorer } from './media-restorer';
import { CheckpointRestorePostCommit } from './post-commit';
import { CheckpointReconciler, type ReconcileResult } from './reconciler';
import { CHECKPOINT_RESTORE_DB, describeRestoreFailure, findRestore, Heartbeat, patchRestore, realClock, RESTORE_CLOCK, type RestoreClock, type RestoreDb } from './restore-row';

/**
 * How long the lock is held after the commit, so every in-process cache over a restored table
 * that has NO invalidation channel has expired before the tenant is writable again. It must be
 * ≥ the longest TTL among them (all per process, inside the gateway):
 *   - TextAgentResolverService resolved agent spec ........ 15 s  (TEXT_SPEC_CACHE_TTL_MS; Agent, AgentAssignment, AiModel, AiProviderConnection)
 *   - ConsultationConsentService grant cache .............. 30 s  (CACHE_TTL_MS; ConsentGrant — invalidated in-process only, the worker cannot reach it)
 *   - AsrLanguageCapabilityService catalog ................ 30 s  (CATALOG_CACHE_TTL_MS; ASR agents)
 *   - EntitlementsService rate-limit policy ............... 30 s  (RATE_LIMIT_POLICY_TTL_MS; not over a restored table today — listed as the bound)
 *   - TenantLockService lock state ........................  5 s  (TENANT_LOCK_CACHE_TTL_MS; also invalidated on publishChange)
 * Caches WITH a channel are invalidated post-commit instead: AppSettings (+ OriginRegistry, which
 * refreshes on it) via the GlobalSetting sys-event, rate-limit rules via their channel, the Redis
 * ability cache (5 min) via PolicyEngine.invalidateTenant. NOT covered by either — reported, not
 * fixed here: IdpResolverService caches OIDC/SAML clients per provider id with NO TTL.
 */
export const POST_COMMIT_SETTLE_MS = 30_000;
/** Grace after the lock is published, so in-flight requests finish before the safety checkpoint. */
export const LOCK_DRAIN_MS = 5_000;
export const RESTORE_HEARTBEAT_MS = 15_000;

@Injectable()
export class CheckpointRestoreRunner extends BaseService {
  private readonly logger = new Logger(CheckpointRestoreRunner.name);
  heartbeatIntervalMs = RESTORE_HEARTBEAT_MS;

  constructor(
    private readonly restores: TenantCheckpointRestoreRepository,
    private readonly checkpoints: TenantCheckpointRepository,
    @Inject(ITenantLockService) private readonly lock: ITenantLockService,
    @Inject(ICheckpointExportRunner) private readonly exportRunner: ICheckpointExportRunner,
    @Inject(ICheckpointSealing) private readonly sealing: ICheckpointSealing,
    @Inject(ICheckpointStore) private readonly store: ICheckpointStore,
    private readonly reconciler: CheckpointReconciler,
    private readonly postCommit: CheckpointRestorePostCommit,
    private readonly media: CheckpointMediaRestorer,
    @Inject(CHECKPOINT_RESTORE_DB) private readonly db: RestoreDb,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(RESTORE_CLOCK) private readonly clock: RestoreClock = realClock,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantCheckpointRestore);
  }

  async run(restoreId: string): Promise<void> {
    const row = await findRestore(this.restores, restoreId);
    if (!row || row.status !== TenantCheckpointRestoreStatus.PENDING) return; // re-delivered job: idempotent
    const work = async () => {
      this.clsService.set('tenantId', row.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: row.tenantId, userId: row.requestedBy, kind: 'tenant-checkpoint-restore' }) as never);
      await this.restore(row);
    };
    if (this.clsService.isActive()) await work();
    else await this.clsService.run(work);
  }

  private async restore(initial: TenantCheckpointRestoreEntity): Promise<void> {
    const id = initial.id;
    const tenantId = initial.tenantId;
    const categories = [...initial.categories] as RestorableCategory[];
    const aborted = { reason: null as string | null };
    const heartbeat = new Heartbeat(
      this.heartbeatIntervalMs,
      async () => {
        await patchRestore(this.restores, id, (row) => {
          if (TERMINAL.has(row.status)) {
            aborted.reason = `the restore was marked ${row.status} by the sweeper`;
            return false;
          }
          row.heartbeatAt = this.date();
        });
      },
      (error) => this.logger.warn({ message: 'Restore heartbeat write failed', restoreId: id, error: errorName(error) }),
    );

    let committedAt: number | null = null;
    let result: ReconcileResult | null = null;
    let safetyCheckpointId: string | null = null;
    try {
      // 1. LOCKING ------------------------------------------------------------------------------
      await this.setStatus(id, TenantCheckpointRestoreStatus.LOCKING, (row) => {
        const now = this.date();
        row.lockAcquiredAt = now;
        row.startedAt = now;
        row.heartbeatAt = now;
      });
      await this.lock.publishChange(tenantId);
      heartbeat.start();
      await this.clock.sleep(LOCK_DRAIN_MS);

      // 2. SAFETY_CHECKPOINT --------------------------------------------------------------------
      await this.setStatus(id, TenantCheckpointRestoreStatus.SAFETY_CHECKPOINT);
      safetyCheckpointId = await this.safetyCheckpoint(initial, categories);
      await this.setStatus(id, null, (row) => {
        row.safetyCheckpointId = safetyCheckpointId;
      });

      // 3. VERIFYING ----------------------------------------------------------------------------
      await this.setStatus(id, TenantCheckpointRestoreStatus.VERIFYING);
      const source = await this.checkpoints.findById(initial.checkpointId).catch(() => null);
      if (!source || source.tenantId !== tenantId || source.status !== TenantCheckpointStatus.READY || !source.objectKey) {
        throw new CheckpointError('RESTORE_FAILED', 'The source checkpoint is no longer available', { checkpointId: initial.checkpointId });
      }
      const objectKey = source.objectKey;
      const verified = await verifyArchive({ open: () => this.store.openReadStream(objectKey), expectTenantId: tenantId, sealing: this.sealing });

      // 4. media bytes missing from their buckets ----------------------------------------------
      if (categories.includes('CLINICAL') && verified.header.includesMedia && verified.manifest.media?.length) {
        await this.withReader(verified, objectKey, (reader) => this.media.reupload(tenantId, verified.manifest, reader, this.db.query));
      }
      this.throwIfAborted(aborted);

      // 5. RECONCILING — one transaction ------------------------------------------------------
      await this.setStatus(id, TenantCheckpointRestoreStatus.RECONCILING);
      const client = await this.db.connect();
      let clientError: Error | undefined;
      try {
        result = await this.withReader(verified, objectKey, (reader) =>
          this.reconciler.reconcile(client, {
            tenantId,
            categories,
            reader,
            actorId: initial.requestedBy,
            restoreId: id,
            beforeCommit: async () => {
              this.throwIfAborted(aborted);
              const row = await findRestore(this.restores, id);
              if (!row || row.status !== TenantCheckpointRestoreStatus.RECONCILING) {
                throw new CheckpointError('RESTORE_FAILED', 'The restore was ended by the sweeper before it could commit');
              }
            },
          }),
        );
        committedAt = this.clock.now();
      } catch (error) {
        clientError = error instanceof Error ? error : undefined;
        throw error;
      } finally {
        client.release(clientError);
      }
    } catch (error) {
      heartbeat.stop();
      await this.fail(initial, error, safetyCheckpointId);
      return;
    }

    // 6. POST_COMMIT — never undoes the restore ---------------------------------------------------
    const done = result!;
    const warnings: RestoreWarning[] = [...done.warnings];
    try {
      await this.setStatus(id, TenantCheckpointRestoreStatus.POST_COMMIT);
      warnings.push(
        ...(await this.postCommit.run({ tenantId, restoreId: id, actorId: initial.requestedBy, categories, result: done, query: this.db.query })),
      );
    } catch (error) {
      warnings.push({ code: 'POST_COMMIT_FAILED', message: 'Post-commit steps did not complete', detail: { error: errorName(error) } });
    }

    // settle: caches without an invalidation channel must expire before the tenant is writable
    const waited = this.clock.now() - committedAt!;
    if (waited < POST_COMMIT_SETTLE_MS) await this.clock.sleep(POST_COMMIT_SETTLE_MS - waited);

    // 7. unlock --------------------------------------------------------------------------------
    heartbeat.stop();
    const status = warnings.length ? TenantCheckpointRestoreStatus.COMPLETED_WITH_WARNINGS : TenantCheckpointRestoreStatus.COMPLETED;
    await this.finish(initial, status, (row) => {
      row.counts = done.counts as never;
      row.warnings = warnings as never;
    }).catch((error) => this.logger.error({ message: 'Could not record the restore outcome', restoreId: id, error: errorName(error) }));
    await this.lock.publishChange(tenantId);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      forceAuditLog: true,
      responsibleEntityId: initial.requestedBy,
      data: {
        action: 'tenant-restore',
        status,
        checkpointId: initial.checkpointId,
        categories,
        reason: initial.reason,
        counts: done.counts,
        warnings: warnings.map((w) => w.code),
        safetyCheckpointId,
      },
    });
  }

  /** A full SAFETY checkpoint of the tenant, run inline; its row must end READY. */
  private async safetyCheckpoint(restore: TenantCheckpointRestoreEntity, categories: readonly RestorableCategory[]): Promise<string> {
    const key = await this.sealing.generateDataKey();
    key.plaintext.fill(0);
    const entity = TenantCheckpointFactory.CreateTenantCheckpoint({
      tenantId: restore.tenantId,
      label: `Safety checkpoint before restore ${restore.id}`,
      kind: TenantCheckpointKind.SAFETY,
      includesMedia: categories.includes('CLINICAL'),
      keyEnvelope: { platform: key.platformWrapped } as never,
      createdBy: restore.requestedBy,
    });
    const created = await this.checkpoints.create(entity);
    await this.exportRunner.run(created.id);
    const done = await this.checkpoints.findById(created.id).catch(() => null);
    if (!done || done.status !== TenantCheckpointStatus.READY) {
      throw new CheckpointError('RESTORE_FAILED', 'The safety checkpoint did not complete; nothing was restored', {
        safetyCheckpointId: created.id,
        status: done?.status ?? null,
      });
    }
    return created.id;
  }

  /** Opens the verified object again; the header must be the one the gate vouched for. */
  private async withReader<T>(verified: VerifiedArchive, objectKey: string, work: (reader: Awaited<ReturnType<typeof openArchive>>) => Promise<T>): Promise<T> {
    const dataKey = await this.sealing.unwrapPlatform(verified.header.keys.platform);
    try {
      const reader = await openArchive(await this.store.openReadStream(objectKey), dataKey);
      if (!isDeepStrictEqual(reader.header, verified.header)) {
        throw new CheckpointError('SIGNATURE_INVALID', 'The checkpoint changed after it was verified');
      }
      return await work(reader);
    } finally {
      dataKey.fill(0);
    }
  }

  private async fail(restore: TenantCheckpointRestoreEntity, error: unknown, safetyCheckpointId: string | null): Promise<void> {
    const { reason, detail } = describeRestoreFailure(error);
    this.logger.error({ message: 'Tenant restore failed', restoreId: restore.id, reason, error: errorName(error) });
    await this.finish(restore, TenantCheckpointRestoreStatus.FAILED, (row) => {
      row.failureReason = reason;
      row.failureDetail = detail;
    }).catch((e) => this.logger.error({ message: 'Could not record the restore failure', restoreId: restore.id, error: errorName(e) }));
    await this.lock.publishChange(restore.tenantId);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: restore.id,
      forceAuditLog: true,
      responsibleEntityId: restore.requestedBy,
      data: {
        action: 'tenant-restore',
        status: TenantCheckpointRestoreStatus.FAILED,
        checkpointId: restore.checkpointId,
        categories: restore.categories,
        reason: restore.reason,
        failureReason: reason,
        safetyCheckpointId,
      },
    });
  }

  /** Terminal write: status, lock released, finished. Skipped if the sweeper already ended the row. */
  private async finish(restore: TenantCheckpointRestoreEntity, status: TenantCheckpointRestoreStatus, edit: (row: TenantCheckpointRestoreEntity) => void): Promise<void> {
    const now = this.date();
    await patchRestore(this.restores, restore.id, (row) => {
      if (TERMINAL.has(row.status)) return false;
      row.status = status;
      row.lockReleasedAt = now;
      row.finishedAt = now;
      row.heartbeatAt = now;
      edit(row);
    });
  }

  private async setStatus(id: string, status: TenantCheckpointRestoreStatus | null, edit?: (row: TenantCheckpointRestoreEntity) => void): Promise<void> {
    const written = await patchRestore(this.restores, id, (row) => {
      if (TERMINAL.has(row.status)) return false;
      if (status) row.status = status;
      row.heartbeatAt = this.date();
      edit?.(row);
    });
    if (!written) throw new CheckpointError('RESTORE_FAILED', 'The restore row was ended or removed while running');
  }

  private throwIfAborted(aborted: { reason: string | null }): void {
    if (aborted.reason) throw new CheckpointError('RESTORE_FAILED', `Stopped: ${aborted.reason}`);
  }

  private date(): Date {
    return new Date(this.clock.now());
  }
}

const TERMINAL: ReadonlySet<string> = new Set([
  TenantCheckpointRestoreStatus.COMPLETED,
  TenantCheckpointRestoreStatus.COMPLETED_WITH_WARNINGS,
  TenantCheckpointRestoreStatus.FAILED,
]);

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error';
}
