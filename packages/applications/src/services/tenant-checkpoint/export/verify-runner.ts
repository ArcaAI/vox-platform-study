/**
 * Verification of an uploaded checkpoint: the full gate (`verifyArchive`) over the object the
 * browser uploaded. A pass fills the row from the verified header and manifest (`READY`,
 * `origin: UPLOADED`); a refusal writes only `FAILED` + the gate's reason, and deletes the
 * untrusted object.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantCheckpointKind,
  TenantCheckpointOrigin,
  TenantCheckpointRepository,
  TenantCheckpointStatus,
  type TenantCheckpointEntity,
} from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { TENANT_CHECKPOINT_RETENTION_DAYS_KEY } from '../../settings-registry/descriptors/tenant-checkpoint.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { verifyArchive } from '../archive';
import { ICheckpointSealing, ICheckpointStore, type ICheckpointVerifyRunner, type ManifestSummary } from '../contracts';
import { describeFailure, findCheckpoint, patchCheckpoint, RowHeartbeat, writeHeartbeat } from './checkpoint-row';

const DAY_MS = 86_400_000;
const AWAITING_VERIFICATION: readonly string[] = [TenantCheckpointStatus.UPLOADING, TenantCheckpointStatus.PENDING];

@Injectable()
export class CheckpointVerifyRunner extends BaseService implements ICheckpointVerifyRunner {
  private readonly logger = new Logger(CheckpointVerifyRunner.name);
  heartbeatIntervalMs = 15_000;
  now: () => Date = () => new Date();

  constructor(
    private readonly checkpoints: TenantCheckpointRepository,
    @Inject(ICheckpointSealing) private readonly sealing: ICheckpointSealing,
    @Inject(ICheckpointStore) private readonly store: ICheckpointStore,
    private readonly settings: TenantSettingsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantCheckpoint);
  }

  async run(checkpointId: string): Promise<void> {
    const row = await findCheckpoint(this.checkpoints, checkpointId);
    if (!row || !AWAITING_VERIFICATION.includes(row.status)) return; // re-delivered job: idempotent
    // Read in the caller's (processor's) tenant session; the verification runs in a nested session of its own.
    await this.clsService.run({ ifNested: 'inherit' }, async () => {
      this.clsService.set('tenantId', row.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: row.tenantId, kind: 'tenant-checkpoint-verify' }) as never);
      await this.verify(row);
    });
  }

  private async verify(initial: TenantCheckpointEntity): Promise<void> {
    const id = initial.id;
    const tenantId = initial.tenantId;
    const key = initial.objectKey ?? this.store.objectKey(tenantId, id);
    const heartbeat = new RowHeartbeat(
      this.heartbeatIntervalMs,
      () => writeHeartbeat(this.checkpoints, id, this.now(), { phase: 'verifying' }, () => undefined),
      () => undefined,
    );
    try {
      const started = this.now();
      const running = await patchCheckpoint(this.checkpoints, id, (row) => {
        if (!AWAITING_VERIFICATION.includes(row.status)) return false;
        row.status = TenantCheckpointStatus.RUNNING;
        row.startedAt = started;
        row.heartbeatAt = started;
        row.progress = { phase: 'verifying' } as never;
      });
      if (!running) return;
      heartbeat.start();

      const verified = await verifyArchive({
        open: () => this.store.openReadStream(key),
        expectTenantId: tenantId,
        sealing: this.sealing,
        existingCheckpointIds: await this.heldCheckpointIds(tenantId, id),
      });
      heartbeat.stop();

      const { header, manifest } = verified;
      const finished = this.now();
      const retentionDays = this.settings.resolve<number>(TENANT_CHECKPOINT_RETENTION_DAYS_KEY, tenantId).value;
      const summary: ManifestSummary = { tables: manifest.tables.map((t) => ({ model: t.model, columns: t.columns, rowCount: t.rowCount })) };
      await patchCheckpoint(this.checkpoints, id, (row) => {
        row.status = TenantCheckpointStatus.READY;
        row.origin = TenantCheckpointOrigin.UPLOADED;
        row.kind = TenantCheckpointKind.MANUAL;
        row.keyEnvelope = header.keys as never;
        row.passphraseProtected = Boolean(header.keys.passphrase);
        row.includesMedia = header.includesMedia;
        row.objectKey = key;
        row.uploadId = null;
        row.sizeBytes = verified.sizeBytes;
        row.manifestDigest = createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
        row.manifestSummary = summary as never;
        row.schemaFingerprint = header.schemaFingerprint;
        row.sourceDeploymentId = header.sourceDeploymentId;
        row.formatVersion = header.formatVersion;
        row.finishedAt = finished;
        row.heartbeatAt = finished;
        row.expiresAt = new Date(finished.getTime() + retentionDays * DAY_MS);
        row.failureReason = null;
        row.failureDetail = null;
        row.metaData = { ...(row.metaData ?? {}), sourceCheckpointId: header.checkpointId, sourceCreatedAt: header.createdAt };
      });
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: id,
        data: { status: TenantCheckpointStatus.READY, origin: TenantCheckpointOrigin.UPLOADED, sizeBytes: verified.sizeBytes },
      });
    } catch (error) {
      heartbeat.stop();
      const { reason, detail } = describeFailure(error);
      this.logger.warn({ message: 'Uploaded checkpoint refused', checkpointId: id, reason });
      await patchCheckpoint(this.checkpoints, id, (row) => {
        if (row.status !== TenantCheckpointStatus.RUNNING) return false;
        row.status = TenantCheckpointStatus.FAILED;
        row.failureReason = reason;
        row.failureDetail = detail;
        row.finishedAt = this.now();
      });
      // The object is untrusted bytes nothing can use; a retry is a fresh upload.
      await this.store.delete(key).catch((e) =>
        this.logger.warn({
          message: 'Deleting a refused checkpoint upload failed',
          checkpointId: id,
          error: e instanceof Error ? e.name : 'Error',
        }),
      );
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: id,
        data: { status: TenantCheckpointStatus.FAILED, failureReason: reason },
      });
    } finally {
      heartbeat.stop();
    }
  }

  /** Checkpoint ids the tenant already holds: READY rows' own ids and the source ids of uploaded ones. */
  private async heldCheckpointIds(tenantId: string, selfId: string): Promise<Set<string>> {
    const rows = await this.checkpoints.findAll({
      where: { tenantId, status: TenantCheckpointStatus.READY, resourceStatus: { not: ResourceStatusType.DELETED } } as never,
    });
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.id === selfId) continue;
      ids.add(r.id);
      const source = (r.metaData as { sourceCheckpointId?: unknown } | undefined)?.sourceCheckpointId;
      if (typeof source === 'string') ids.add(source);
    }
    return ids;
  }
}
