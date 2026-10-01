import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  CoreDatabaseService,
  JobQueue,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantCheckpointCategory,
  TenantCheckpointFactory,
  TenantCheckpointKind,
  TenantCheckpointOrigin,
  TenantCheckpointRepository,
  generateId,
  TenantCheckpointRestoreFactory,
  TenantCheckpointRestoreRepository,
  TenantCheckpointRestoreStatus,
  TenantCheckpointStatus,
  TenantRepository,
  UserRepository,
} from '@arcaai/domains';
import type { TenantCheckpointEntity, TenantCheckpointRestoreEntity } from '@arcaai/domains';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ICryptoService } from '../crypto/ICryptoService';
import { checkBreakGlass, type BreakGlassOutcome } from '../rbac/breakGlass';
import { TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY, TENANT_CHECKPOINT_DEFAULTS } from '../settings-registry/descriptors/tenant-checkpoint.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import {
  CHECKPOINT_UPLOAD_PART_BYTES,
  CheckpointError,
  ICheckpointSealing,
  ICheckpointStore,
  SYSTEM_TENANT_ID,
  type CheckpointExportJob,
  type CheckpointRestoreJob,
  type KeyEnvelope,
  type ManifestSummary,
  type RestorableCategory,
  type SqlQuery,
} from './contracts';
import {
  CHECKPOINT_LIST_DEFAULT_LIMIT,
  type CheckpointDownloadUrlResponse,
  type CompleteCheckpointUploadRequest,
  type CreateCheckpointRequest,
  type InitCheckpointUploadRequest,
  type InitCheckpointUploadResponse,
  type ListCheckpointsQuery,
  type ListRestoresQuery,
  type PaginatedTenantCheckpointResponse,
  type PaginatedTenantCheckpointRestoreResponse,
  type RestoreCheckpointRequest,
  type TenantCheckpointResponse,
  type TenantCheckpointRestoreResponse,
  RESTORE_REASON_MAX,
  RESTORE_REASON_MIN,
  CHECKPOINT_PASSPHRASE_MAX,
  CHECKPOINT_PASSPHRASE_MIN,
} from './dto';
import { ITenantCheckpointService } from './ITenantCheckpointService';
import { CHECKPOINT_REGISTRY } from './registry/registry';
import { checkCompatibility } from './registry/schema';
import { TenantCheckpointDtoMapper } from './tenant-checkpoint.dto.mapper';

/** Presigned download lifetime. */
export const CHECKPOINT_DOWNLOAD_TTL_SECONDS = 900;
/** Presigned multipart part lifetime — long enough for a slow browser upload of a large archive. */
export const CHECKPOINT_UPLOAD_TTL_SECONDS = 6 * 60 * 60;
/** `data.action` discriminator on every break-glass audit row of a restore. */
export const TENANT_RESTORE_BREAK_GLASS_AUDIT_ACTION = 'TENANT_RESTORE_BREAK_GLASS';

const BYTES_PER_GB = 1024 ** 3;
const RESTORE_BREAK_GLASS_OPERATION = 'Restoring a tenant checkpoint';
const ACTIVE_STATUSES: readonly TenantCheckpointStatus[] = [
  TenantCheckpointStatus.PENDING,
  TenantCheckpointStatus.UPLOADING,
  TenantCheckpointStatus.RUNNING,
];
const RESTORABLE_POLICIES = new Set(['RECONCILE', 'INSERT_ONLY', 'RETIRE_ONLY']);

const pad = (n: number): string => String(n).padStart(2, '0');

/** `<tenantKey>-<yyyyMMdd-HHmm>-<id8>.hcp`, UTC. */
export function checkpointFilename(tenantKey: string, createdAt: Date, id: string): string {
  const stamp = `${createdAt.getUTCFullYear()}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}-${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}`;
  return `${tenantKey}-${stamp}-${id.slice(0, 8)}.hcp`;
}

function isActiveRestoreUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'P2002' || /one_active_per_tenant/.test(e?.message ?? '');
}

@Injectable()
export class TenantCheckpointService extends BaseService implements ITenantCheckpointService {
  constructor(
    private readonly checkpoints: TenantCheckpointRepository,
    private readonly restores: TenantCheckpointRestoreRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    @Inject(ICryptoService) private readonly crypto: ICryptoService,
    @Inject(ICheckpointSealing) private readonly sealing: ICheckpointSealing,
    @Inject(ICheckpointStore) private readonly store: ICheckpointStore,
    private readonly settings: TenantSettingsService,
    private readonly databaseService: CoreDatabaseService,
    @InjectQueue(JobQueue.TenantCheckpointExport) private readonly exportQueue: Queue,
    @InjectQueue(JobQueue.TenantCheckpointRestore) private readonly restoreQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantCheckpoint);
  }


  /**
   * Broadcast a sys-event attributed to the TARGET tenant (`:tenantId`), not the request's CLS tenant.
   * `BaseService.broadcastSysEvent` deliberately pins attribution to CLS (anti-spoofing), which would
   * audit a platform admin's cross-tenant action — a PHI download above all — against SYSTEM or their
   * working tenant. Here the tenant is the route's, already pinned by the controller and the service,
   * so it is safe to stamp explicitly (same direct-emit shape as the break-glass audit).
   */
  private emitFor(tenantId: string, type: SysEventType, data: Record<string, unknown>): void {
    this.eventEmitter.emit(type, {
      id: generateId(),
      type,
      ...(this.requestServiceAccount ? { responsibleServiceAccountId: this.requestServiceAccount.id } : { responsibleEntityId: this.requestUser?.id }),
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      ...data,
      tenantId,
    });
  }

  // ── guards & loaders ────────────────────────────────────────────────────────

  /** The SYSTEM tenant holds platform defaults, not tenant data: it is never checkpointed or restored. */
  private assertNotSystem(tenantId: string): void {
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException({ code: 'SYSTEM_TENANT_NOT_CHECKPOINTABLE', message: 'The platform (SYSTEM) tenant cannot be checkpointed or restored.' });
    }
  }

  private async loadTenant(tenantId: string) {
    const tenant = await this.tenants.findByIdOrNull(tenantId);
    if (!tenant || tenant.isDeleted) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  /** Existence first, tenancy second, both answered with the same 404. */
  private async loadCheckpoint(tenantId: string, checkpointId: string): Promise<TenantCheckpointEntity> {
    const row = await this.checkpoints.findByIdOrNull(checkpointId);
    if (!row || row.tenantId !== tenantId || row.isDeleted) throw new NotFoundException('Checkpoint not found');
    return row;
  }

  private async loadRestore(tenantId: string, restoreId: string): Promise<TenantCheckpointRestoreEntity> {
    const row = await this.restores.findByIdOrNull(restoreId);
    if (!row || row.tenantId !== tenantId || row.isDeleted) throw new NotFoundException('Restore not found');
    return row;
  }

  /** The `:id` of the upload routes is the multipart upload id; the checkpoint id is accepted as well. */
  private async loadUpload(tenantId: string, uploadRef: string): Promise<TenantCheckpointEntity> {
    const byId = await this.checkpoints.findByIdOrNull(uploadRef);
    let row: TenantCheckpointEntity | null = byId;
    if (!row) {
      try {
        row = await this.checkpoints.findFirst({ where: { tenantId, uploadId: uploadRef } as never });
      } catch {
        row = null;
      }
    }
    if (!row || row.tenantId !== tenantId || row.isDeleted || row.origin !== TenantCheckpointOrigin.UPLOADED) {
      throw new NotFoundException('Upload not found');
    }
    return row;
  }

  private sqlQuery(): SqlQuery {
    return async <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      (await this.databaseService.baseClient.$queryRawUnsafe(sql, ...params)) as T[];
  }

  /** An export or a restore is in flight for the tenant (an idle multipart upload is not "busy"). */
  private async assertNotBusy(tenantId: string): Promise<void> {
    const [running, active] = await Promise.all([this.checkpoints.findRunningByTenant(tenantId), this.restores.findActiveByTenant(tenantId)]);
    const exporting = running.some((c) => c.status !== TenantCheckpointStatus.UPLOADING);
    if (exporting || active) {
      throw new ConflictException({
        code: 'TENANT_CHECKPOINT_BUSY',
        message: 'A checkpoint export or restore is already running for this tenant.',
      });
    }
  }

  private async enqueueExport(job: CheckpointExportJob): Promise<void> {
    await this.exportQueue.add(JobQueue.TenantCheckpointExport, job, {
      // BullMQ refuses a custom id containing ':' (unless it has exactly three parts), hence the dash.
      jobId: job.kind === 'verify-upload' ? `verify-${job.checkpointId}` : job.checkpointId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  private async transition(entity: TenantCheckpointEntity): Promise<TenantCheckpointEntity> {
    if (this.requestUserId) entity.updatedBy = this.requestUserId;
    try {
      return await this.checkpoints.updateWithVersion(entity.id, entity, entity.version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) {
        throw new ConflictException({ code: 'CHECKPOINT_STATE_CHANGED', message: 'The checkpoint changed while the request was running; reload and retry.' });
      }
      throw error;
    }
  }

  // ── create / list / get ─────────────────────────────────────────────────────

  async create(tenantId: string, request: CreateCheckpointRequest): Promise<TenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    await this.loadTenant(tenantId);
    const label = request.label?.trim();
    if (!label) throw new BadRequestException({ code: 'CHECKPOINT_LABEL_REQUIRED', message: 'A checkpoint label is required.' });
    const passphrase = request.passphrase;
    if (passphrase !== undefined && (passphrase.length < CHECKPOINT_PASSPHRASE_MIN || passphrase.length > CHECKPOINT_PASSPHRASE_MAX)) {
      throw new BadRequestException({
        code: 'CHECKPOINT_PASSPHRASE_INVALID',
        message: `The passphrase must be ${CHECKPOINT_PASSPHRASE_MIN}-${CHECKPOINT_PASSPHRASE_MAX} characters.`,
      });
    }
    await this.assertNotBusy(tenantId);

    // The passphrase lives only inside this call: it wraps the data key here, and the job carries ids.
    const keyEnvelope = await this.sealKey(passphrase);

    const entity = TenantCheckpointFactory.CreateTenantCheckpoint({
      tenantId,
      label,
      kind: TenantCheckpointKind.MANUAL,
      origin: TenantCheckpointOrigin.CREATED,
      status: TenantCheckpointStatus.PENDING,
      includesMedia: request.includesMedia,
      passphraseProtected: passphrase !== undefined,
      keyEnvelope: keyEnvelope as never,
      objectKey: null,
      createdBy: this.requestUserId,
    });
    entity.objectKey = this.store.objectKey(tenantId, entity.id);
    const saved = await this.checkpoints.create(entity);

    try {
      await this.enqueueExport({ kind: 'create', checkpointId: saved.id, tenantId });
    } catch (error) {
      await this.failEnqueue(saved, error);
      throw new ServiceUnavailableException({ code: 'CHECKPOINT_QUEUE_UNAVAILABLE', message: 'The checkpoint could not be queued; try again shortly.' });
    }

    this.emitFor(tenantId, SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { tenantId, label, kind: saved.kind, includesMedia: saved.includesMedia, passphraseProtected: saved.passphraseProtected },
    });
    return TenantCheckpointDtoMapper.toResponse(saved);
  }

  private async sealKey(passphrase: string | undefined): Promise<KeyEnvelope> {
    try {
      const { plaintext, platformWrapped } = await this.sealing.generateDataKey();
      try {
        const envelope: KeyEnvelope = { platform: platformWrapped };
        if (passphrase !== undefined) envelope.passphrase = await this.sealing.wrapWithPassphrase(plaintext, passphrase);
        return envelope;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof CheckpointError && error.reason === 'SEALING_UNAVAILABLE') {
        throw new ServiceUnavailableException({ code: 'CHECKPOINT_SEALING_UNAVAILABLE', message: error.message });
      }
      throw error;
    }
  }

  private async failEnqueue(entity: TenantCheckpointEntity, error: unknown): Promise<void> {
    entity.status = TenantCheckpointStatus.FAILED;
    entity.failureReason = 'EXPORT_FAILED';
    entity.failureDetail = `The export job could not be queued: ${error instanceof Error ? error.message : 'unknown error'}`;
    entity.finishedAt = new Date();
    await this.checkpoints.updateWithVersion(entity.id, entity, entity.version).catch(() => undefined);
  }

  async list(tenantId: string, query: ListCheckpointsQuery): Promise<PaginatedTenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    const page = query.page ?? 1;
    const limit = query.limit ?? CHECKPOINT_LIST_DEFAULT_LIMIT;
    const where: Record<string, unknown> = { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } };
    if (query.kind) where.kind = query.kind;
    const search = query.search?.trim();
    const props = {
      where,
      page,
      limit,
      sort: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(search ? { search, searchFields: ['label'] } : {}),
    } as never;
    const [rows, count] = await Promise.all([
      this.checkpoints.findAll(props),
      this.checkpoints.count({ where, ...(search ? { search, searchFields: ['label'] } : {}) } as never),
    ]);
    return TenantCheckpointDtoMapper.toPaginatedResponse(rows, count, page, limit);
  }

  async get(tenantId: string, checkpointId: string): Promise<TenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    return TenantCheckpointDtoMapper.toResponse(await this.loadCheckpoint(tenantId, checkpointId));
  }

  // ── cancel / download / delete ──────────────────────────────────────────────

  async cancel(tenantId: string, checkpointId: string): Promise<TenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    const row = await this.loadCheckpoint(tenantId, checkpointId);
    const cancellable =
      row.origin === TenantCheckpointOrigin.CREATED &&
      (row.status === TenantCheckpointStatus.PENDING || row.status === TenantCheckpointStatus.RUNNING);
    if (!cancellable) {
      throw new ConflictException({ code: 'CHECKPOINT_NOT_CANCELLABLE', message: 'Only a running export can be cancelled.' });
    }
    const now = new Date();
    row.cancelRequestedAt = now;
    // An export no worker has started yet is cancelled outright; a running one notices the request
    // between tables and aborts itself.
    if (row.status === TenantCheckpointStatus.PENDING) {
      row.status = TenantCheckpointStatus.CANCELLED;
      row.finishedAt = now;
    }
    const saved = await this.transition(row);
    this.emitFor(tenantId, SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      data: { tenantId, action: 'cancel', status: saved.status },
    });
    return TenantCheckpointDtoMapper.toResponse(saved);
  }

  async downloadUrl(tenantId: string, checkpointId: string): Promise<CheckpointDownloadUrlResponse> {
    this.assertNotSystem(tenantId);
    const row = await this.loadCheckpoint(tenantId, checkpointId);
    if (row.status !== TenantCheckpointStatus.READY || !row.objectKey) {
      throw new ConflictException({ code: 'CHECKPOINT_NOT_READY', message: 'Only a finished (READY) checkpoint can be downloaded.' });
    }
    const tenant = await this.loadTenant(tenantId);
    const filename = checkpointFilename(tenant.key, row.createdAt, row.id);
    const url = await this.store.presignDownload(row.objectKey, filename, CHECKPOINT_DOWNLOAD_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + CHECKPOINT_DOWNLOAD_TTL_SECONDS * 1000).toISOString();
    // Every issuance is audited, whatever the caller's role: this is a PHI-bearing archive leaving the platform.
    this.emitFor(tenantId, SysEventType.ResourceViewed, {
      resourceId: row.id,
      forceAuditLog: true,
      data: { tenantId, action: 'CHECKPOINT_DOWNLOAD_URL_ISSUED', filename, expiresAt },
    });
    return { url, expiresAt, filename };
  }

  async delete(tenantId: string, checkpointId: string): Promise<void> {
    this.assertNotSystem(tenantId);
    const row = await this.loadCheckpoint(tenantId, checkpointId);
    if ((ACTIVE_STATUSES as readonly string[]).includes(row.status)) {
      throw new ConflictException({ code: 'CHECKPOINT_IN_PROGRESS', message: 'A checkpoint that is still being written cannot be deleted; cancel it first.' });
    }
    const active = await this.restores.findActiveByTenant(tenantId);
    if (active && active.checkpointId === row.id) {
      throw new ConflictException({ code: 'TENANT_CHECKPOINT_BUSY', message: 'This checkpoint is the source of a restore that is still running.' });
    }
    if (row.objectKey) await this.store.delete(row.objectKey);
    await this.checkpoints.softDelete(row.id, this.requestUserId ?? undefined);
    this.emitFor(tenantId, SysEventType.ResourceDeleted, {
      resourceId: row.id,
      data: { tenantId, label: row.label, kind: row.kind },
    });
  }

  // ── uploads ─────────────────────────────────────────────────────────────────

  async initUpload(tenantId: string, request: InitCheckpointUploadRequest): Promise<InitCheckpointUploadResponse> {
    this.assertNotSystem(tenantId);
    await this.loadTenant(tenantId);
    const limitGb = this.settings.resolve<number>(TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY, tenantId).value ?? TENANT_CHECKPOINT_DEFAULTS.maxUploadSizeGb;
    if (request.sizeBytes > limitGb * BYTES_PER_GB) {
      throw new PayloadTooLargeException({
        code: 'CHECKPOINT_TOO_LARGE',
        message: `A checkpoint upload may be at most ${limitGb} GB.`,
      });
    }
    const partCount = Math.ceil(request.sizeBytes / CHECKPOINT_UPLOAD_PART_BYTES);

    const entity = TenantCheckpointFactory.CreateTenantCheckpoint({
      tenantId,
      label: request.filename.trim() || 'Uploaded checkpoint',
      kind: TenantCheckpointKind.MANUAL,
      origin: TenantCheckpointOrigin.UPLOADED,
      status: TenantCheckpointStatus.UPLOADING,
      sizeBytes: request.sizeBytes,
      createdBy: this.requestUserId,
    });
    const objectKey = this.store.objectKey(tenantId, entity.id);
    entity.objectKey = objectKey;
    const { uploadId } = await this.store.createUpload(objectKey);
    entity.uploadId = uploadId;

    let saved: TenantCheckpointEntity;
    let parts: { partNumber: number; url: string }[];
    try {
      saved = await this.checkpoints.create(entity);
      parts = await this.store.presignUploadParts(objectKey, uploadId, partCount, CHECKPOINT_UPLOAD_TTL_SECONDS);
    } catch (error) {
      await this.store.abortUpload(objectKey, uploadId).catch(() => undefined);
      throw error;
    }

    this.emitFor(tenantId, SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { tenantId, action: 'upload-init', filename: request.filename, sizeBytes: request.sizeBytes, partCount },
    });
    return {
      checkpoint: TenantCheckpointDtoMapper.toResponse(saved),
      uploadId,
      partSizeBytes: CHECKPOINT_UPLOAD_PART_BYTES,
      parts,
      expiresAt: new Date(Date.now() + CHECKPOINT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async completeUpload(tenantId: string, uploadRef: string, request: CompleteCheckpointUploadRequest): Promise<TenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    const row = await this.loadUpload(tenantId, uploadRef);
    if (row.status !== TenantCheckpointStatus.UPLOADING || !row.uploadId || !row.objectKey) {
      throw new ConflictException({ code: 'UPLOAD_NOT_IN_PROGRESS', message: 'This upload is not in progress.' });
    }
    let sizeBytes: number;
    try {
      ({ sizeBytes } = await this.store.completeUpload(
        row.objectKey,
        row.uploadId,
        request.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      ));
    } catch (error) {
      if (error instanceof CheckpointError && error.reason === 'UPLOAD_PARTS_INVALID') {
        throw new BadRequestException({ code: 'UPLOAD_PARTS_INVALID', message: error.message });
      }
      throw error;
    }
    // The row stays UPLOADING: the verify runner picks up UPLOADING (or PENDING) rows and moves it to
    // RUNNING itself, with a heartbeat. The multipart upload is finished, so its id is dropped — a
    // repeated `complete` is then 409 and the idle-upload sweeper has nothing to abort.
    row.sizeBytes = sizeBytes;
    row.uploadId = null;
    const saved = await this.transition(row);
    try {
      await this.enqueueExport({ kind: 'verify-upload', checkpointId: saved.id, tenantId });
    } catch (error) {
      await this.failEnqueue(saved, error);
      throw new ServiceUnavailableException({ code: 'CHECKPOINT_QUEUE_UNAVAILABLE', message: 'The upload could not be queued for verification; try again shortly.' });
    }
    this.emitFor(tenantId, SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      data: { tenantId, action: 'upload-complete', sizeBytes },
    });
    return TenantCheckpointDtoMapper.toResponse(saved);
  }

  async abortUpload(tenantId: string, uploadRef: string): Promise<TenantCheckpointResponse> {
    this.assertNotSystem(tenantId);
    const row = await this.loadUpload(tenantId, uploadRef);
    if (row.status !== TenantCheckpointStatus.UPLOADING || !row.uploadId || !row.objectKey) {
      throw new ConflictException({ code: 'UPLOAD_NOT_IN_PROGRESS', message: 'This upload is not in progress.' });
    }
    await this.store.abortUpload(row.objectKey, row.uploadId);
    row.status = TenantCheckpointStatus.CANCELLED;
    row.uploadId = null;
    row.finishedAt = new Date();
    const saved = await this.transition(row);
    this.emitFor(tenantId, SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      data: { tenantId, action: 'upload-abort' },
    });
    return TenantCheckpointDtoMapper.toResponse(saved);
  }

  // ── restore ─────────────────────────────────────────────────────────────────

  async restore(tenantId: string, checkpointId: string, request: RestoreCheckpointRequest): Promise<TenantCheckpointRestoreResponse> {
    this.assertNotSystem(tenantId);
    const checkpoint = await this.loadCheckpoint(tenantId, checkpointId);
    const tenant = await this.loadTenant(tenantId);

    // Request validity (not a privilege check): runs before the ordered gates below.
    const categories = request.categories ?? [];
    if (categories.length === 0 || new Set(categories).size !== categories.length) {
      throw new BadRequestException({ code: 'RESTORE_CATEGORIES_INVALID', message: 'Choose at least one category, each at most once.' });
    }
    const reason = request.reason?.trim() ?? '';
    if (reason.length < RESTORE_REASON_MIN || reason.length > RESTORE_REASON_MAX) {
      throw new BadRequestException({
        code: 'RESTORE_REASON_INVALID',
        message: `A reason of ${RESTORE_REASON_MIN}-${RESTORE_REASON_MAX} characters is required.`,
      });
    }

    // 1. break-glass: 428 missing, 401 wrong password, 400 wrong name. The expected name is the
    //    tenant's CURRENT name, so a rename after the checkpoint never blocks a restore.
    await this.requireBreakGlass(checkpoint, tenant.name, request);

    // 2. AUTH-NOTE: Clinical data is a platform-admin-only category. There is no super-admin CASL
    //    subject and tenant admins legitimately hold manage:TenantCheckpoint for the other two
    //    categories, so the boundary is imperative (a 403 privilege failure, not the 404 tenancy posture).
    if (categories.includes(TenantCheckpointCategory.CLINICAL) && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException({
        code: 'CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN',
        message: 'Restoring clinical data requires a platform administrator.',
      });
    }

    // 3. the source must be a finished checkpoint
    if (checkpoint.status !== TenantCheckpointStatus.READY) {
      throw new ConflictException({ code: 'CHECKPOINT_NOT_READY', message: 'Only a finished (READY) checkpoint can be restored.' });
    }

    // 4. no export or restore may be in flight
    await this.assertNotBusy(tenantId);

    // 5. the checkpoint must map onto the live schema
    await this.assertSchemaCompatible(checkpoint, categories);

    const entity = TenantCheckpointRestoreFactory.CreateTenantCheckpointRestore({
      tenantId,
      checkpointId: checkpoint.id,
      categories: categories as unknown as TenantCheckpointCategory[],
      reason,
      status: TenantCheckpointRestoreStatus.PENDING,
      requestedBy: this.requestUserId as string,
      createdBy: this.requestUserId,
    });
    let saved: TenantCheckpointRestoreEntity;
    try {
      saved = await this.restores.create(entity);
    } catch (error) {
      if (isActiveRestoreUniqueViolation(error)) {
        throw new ConflictException({ code: 'TENANT_CHECKPOINT_BUSY', message: 'A restore is already running for this tenant.' });
      }
      throw error;
    }

    const job: CheckpointRestoreJob = { restoreId: saved.id, tenantId };
    try {
      await this.restoreQueue.add(JobQueue.TenantCheckpointRestore, job, { jobId: saved.id, attempts: 1, removeOnComplete: true, removeOnFail: 100 });
    } catch (error) {
      saved.status = TenantCheckpointRestoreStatus.FAILED;
      saved.failureReason = 'RESTORE_FAILED';
      saved.failureDetail = `The restore job could not be queued: ${error instanceof Error ? error.message : 'unknown error'}`;
      await this.restores.updateWithVersion(saved.id, saved, saved.version).catch(() => undefined);
      throw new ServiceUnavailableException({ code: 'CHECKPOINT_QUEUE_UNAVAILABLE', message: 'The restore could not be queued; try again shortly.' });
    }

    this.emitFor(tenantId, SysEventType.ResourceCreated, {
      resourceId: saved.id,
      resourceType: ResourceType.TenantCheckpointRestore,
      forceAuditLog: true,
      data: { tenantId, action: 'TENANT_RESTORE_REQUESTED', checkpointId: checkpoint.id, categories, reason },
    });
    return TenantCheckpointDtoMapper.toRestoreResponse(saved);
  }

  private async requireBreakGlass(checkpoint: TenantCheckpointEntity, tenantName: string, request: RestoreCheckpointRequest): Promise<void> {
    const result = await checkBreakGlass({
      operation: RESTORE_BREAK_GLASS_OPERATION,
      expectedName: tenantName,
      userId: this.requestUserId,
      credentials: { password: request.password, confirmationName: request.confirmationName },
      loadPasswordHash: async () => {
        const user = await this.users.findById(this.requestUserId as string);
        return (user as unknown as { password: string }).password;
      },
      verifyPassword: (password, hash) => this.crypto.verify(password, hash),
    });
    if (!result.ok) {
      this.emitBreakGlassAudit(result.outcome, checkpoint);
      throw result.error;
    }
  }

  /** Forced audit row for a rejected break-glass; NEVER carries the password or the typed name. */
  private emitBreakGlassAudit(outcome: BreakGlassOutcome, checkpoint: TenantCheckpointEntity): void {
    this.eventEmitter.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      resourceId: checkpoint.id,
      tenantId: checkpoint.tenantId,
      forceAuditLog: true,
      data: {
        action: TENANT_RESTORE_BREAK_GLASS_AUDIT_ACTION,
        outcome,
        checkpointId: checkpoint.id,
        actorId: this.requestUser?.id,
        at: new Date().toISOString(),
      },
    });
  }

  private async assertSchemaCompatible(checkpoint: TenantCheckpointEntity, categories: readonly RestorableCategory[]): Promise<void> {
    const summary = checkpoint.manifestSummary as unknown as ManifestSummary | null;
    if (!summary?.tables) return;
    const restorable = new Set(
      CHECKPOINT_REGISTRY.filter((d) => (categories as readonly string[]).includes(d.category) && RESTORABLE_POLICIES.has(d.policy)).map((d) => d.model),
    );
    const problems = await checkCompatibility({ tables: summary.tables.filter((t) => restorable.has(t.model)) }, this.sqlQuery());
    if (problems.length > 0) {
      throw new ConflictException({
        code: 'SCHEMA_INCOMPATIBLE',
        message: 'This checkpoint cannot be restored into the current database schema.',
        problems,
      });
    }
  }

  // ── restore reads ───────────────────────────────────────────────────────────

  async listRestores(tenantId: string, query: ListRestoresQuery): Promise<PaginatedTenantCheckpointRestoreResponse> {
    this.assertNotSystem(tenantId);
    const page = query.page ?? 1;
    const limit = query.limit ?? CHECKPOINT_LIST_DEFAULT_LIMIT;
    const { rows, total } = await this.restores.findByTenant(tenantId, { skip: Math.max(0, (page - 1) * limit), take: limit });
    return TenantCheckpointDtoMapper.toPaginatedRestoreResponse(rows, total, page, limit);
  }

  async getRestore(tenantId: string, restoreId: string): Promise<TenantCheckpointRestoreResponse> {
    this.assertNotSystem(tenantId);
    return TenantCheckpointDtoMapper.toRestoreResponse(await this.loadRestore(tenantId, restoreId));
  }
}
