import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationAttachmentEntity,
  ConsultationAttachmentFactory,
  ConsultationAttachmentKind,
  ConsultationAttachmentPurpose,
  ConsultationAttachmentRepository,
  ConsultationAttachmentStatus,
  ConsultationRepository,
  ResourceType,
  SysEventType,
  TenantBucketPurpose,
} from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { BaseService } from '../../../common/base.service';
import { encryptPhiFields } from '../../../common/phi-field-encryption';
import { assertParentInScope } from '../../../common/tenant-guards';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { BlobObjectHead } from '../../baseServices/storage/providers/IBlobStorageProvider';
import { IBlobStorageService } from '../../baseServices/storage/IBlobStorageService';
import { IMediaService } from '../../media/media/IMediaService';
import { TEXT_SNIFF_BYTES, attachmentContentMatches, audioContentMatches } from '../../media-upload/media-content-sniff';
import { BATCH_TRANSCRIPTION_DEFAULTS, batchTranscriptionKey } from '../../settings-registry/descriptors/batch-transcription.descriptors';
import { CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS } from '../../settings-registry/descriptors/consultation-attachments-feedback.descriptors';
import {
  MEDIA_UPLOAD_DEFAULTS,
  MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY,
  MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY,
} from '../../settings-registry/descriptors/media-upload.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { ITenantBucketService } from '../../tenant-bucket/ITenantBucketService';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
import { AttachmentCapabilityService } from './attachment-capability.service';
import {
  ATTACHMENT_ERROR_CODES,
  AttachmentErrorCode,
  AttachmentKind,
  AttachmentPolicyError,
  AttachmentPurpose,
  AttachmentSizeSettings,
  AttachmentUploadMode,
  attachmentExtension,
  buildAttachmentObjectKey,
  normalizeAttachmentMime,
  resolveMaxSizeBytes,
  validateIntent,
} from './attachment-policy';
import { AttachmentIntentResponse, AttachmentResponse, AttachmentUploadHeaders, CreateAttachmentIntentRequest } from './dto';
import { AttachmentContentUpload, IConsultationAttachmentService } from './IConsultationAttachmentService';
import { AttachmentProcessInput, AttachmentProcessOutcome } from './processors/attachment-processor';
import { AudioAttachmentProcessor } from './processors/audio.processor';
import { CaseNoteAttachmentProcessor } from './processors/case-note.processor';
import { DocumentAttachmentProcessor } from './processors/document.processor';
import { ImageAttachmentProcessor } from './processors/image.processor';

const MB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

const MULTIPART_MAX_MB_KEY = 'consultation.attachments.multipartMaxMb';
const UPLOAD_URL_TTL_SECONDS_KEY = 'consultation.attachments.uploadUrlTtlSeconds';
const INTENT_TTL_HOURS_KEY = 'consultation.attachments.intentTtlHours';
const INLINE_VERIFY_MAX_MB_KEY = 'consultation.attachments.inlineVerifyMaxMb';
const BATCH_MAX_FILE_SIZE_MB_KEY = batchTranscriptionKey('maxFileSizeMb');

/** The declared default of every key this service reads — used only when the settings plane cannot answer. */
const SETTING_DEFAULTS: Readonly<Record<string, number>> = {
  [MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY]: MEDIA_UPLOAD_DEFAULTS.maxAttachmentSizeMb,
  [MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY]: MEDIA_UPLOAD_DEFAULTS.maxAudioSizeMb,
  [BATCH_MAX_FILE_SIZE_MB_KEY]: BATCH_TRANSCRIPTION_DEFAULTS.maxFileSizeMb,
  ...Object.fromEntries(
    CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS.filter((d) => typeof d.default === 'number').map((d) => [d.key, d.default as number]),
  ),
};

const KIND_TO_ENUM: Readonly<Record<AttachmentKind, ConsultationAttachmentKind>> = {
  document: ConsultationAttachmentKind.DOCUMENT,
  image: ConsultationAttachmentKind.IMAGE,
  audio: ConsultationAttachmentKind.AUDIO,
  case_note: ConsultationAttachmentKind.CASE_NOTE,
};
const ENUM_TO_KIND = Object.fromEntries(Object.entries(KIND_TO_ENUM).map(([k, v]) => [v, k])) as Record<string, AttachmentKind>;

/** Audio goes to the recordings bucket, everything else to the attachments bucket (the `POST /media` cascade). */
const BUCKET_CASCADE: Readonly<Record<'attachment' | 'audio', { purpose: TenantBucketPurpose; slugs: readonly string[] }>> = {
  attachment: { purpose: TenantBucketPurpose.ATTACHMENTS, slugs: ['attachments'] },
  audio: { purpose: TenantBucketPurpose.AUDIO, slugs: ['recordings', 'audio'] },
};

const UPLOAD_MODE_COLUMN: Readonly<Record<AttachmentUploadMode, string>> = { presigned: 'PRESIGNED', gateway: 'GATEWAY' };
const PROCESSING_ATTACHMENT = 'PROCESSING_ATTACHMENT' as const;
const PROCESSING_FAILED = 'ATTACHMENT_PROCESSING_FAILED';
/** Statuses a verification or processing failure may move to FAILED. */
const IN_PROGRESS = [ConsultationAttachmentStatus.UPLOADED, ConsultationAttachmentStatus.PROCESSING];

const hexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

/** The stored bytes as verification sees them: always the size and the head; the body only when already in memory. */
interface StoredBytes {
  size: number;
  head: Buffer;
  body?: Buffer;
  /** Base64 SHA-256 the store recorded on write (S3/MinIO with a signed checksum). */
  storeChecksum?: string;
  /** Streams the object for a server re-hash. */
  stream?: () => Promise<Readable>;
}

/** A refusal raised after the bytes were claimed: the object is removed and the row FAILED. */
class AttachmentRejection extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    readonly http: HttpException,
  ) {
    super(code);
  }
}

/**
 * Consultation attachments: intent → PUT (presigned, or `content` through the gateway) → complete.
 *
 * - **Intent** checks the kind against what the consultation can process (422 with the supported
 *   list), the type (415), the size (413) and the tenant quota with the DECLARED size (409), then
 *   signs a PUT bound to the content type, the exact length and — where the store enforces it — the
 *   SHA-256. An `Idempotency-Key` replay with the same body returns the same attachment with a fresh
 *   URL while it is still an INTENT; a different body under the key is 409.
 * - **Complete** claims the row with a conditional INTENT → UPLOADED (the reaper uses the same
 *   column, so exactly one of them wins), re-checks the quota with the REAL size, and verifies size,
 *   magic bytes and SHA-256 (the store's checksum when it recorded one, otherwise a server re-hash —
 *   asynchronously, answered 202, above `inlineVerifyMaxMb`). A failed check deletes the object and
 *   FAILs the row; the client opens a new intent. A passed one writes the `Media` row and dispatches
 *   by kind; `purpose = feedback` stops at the `Media` row.
 *
 * Object keys carry ids only; the client's file name is stored as Transit ciphertext.
 */
@Injectable()
export class ConsultationAttachmentService extends BaseService implements IConsultationAttachmentService {
  private readonly logger = new Logger(ConsultationAttachmentService.name);

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly attachmentRepository: ConsultationAttachmentRepository,
    private readonly consultationRepository: ConsultationRepository,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    @Inject(ITenantBucketService) private readonly tenantBuckets: ITenantBucketService,
    @Inject(IMediaService) private readonly mediaService: IMediaService,
    private readonly settings: TenantSettingsService,
    private readonly capability: AttachmentCapabilityService,
    @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate: IConsultationLifecycleGate,
    private readonly caseNotes: CaseNoteAttachmentProcessor,
    private readonly documents: DocumentAttachmentProcessor,
    private readonly images: ImageAttachmentProcessor,
    private readonly audio: AudioAttachmentProcessor,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationAttachment);
  }

  // ============================================================
  // Intent
  // ============================================================

  async createIntent(consultationId: string, request: CreateAttachmentIntentRequest, idempotencyKey?: string): Promise<AttachmentIntentResponse> {
    const tenantId = this.requireTenant();
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    const purpose: AttachmentPurpose = request.purpose ?? 'attachment';
    if (purpose === 'attachment') await this.lifecycleGate.assertContentWritable(consultationId);

    const key = idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = await this.attachmentRepository.findByIdempotencyKey(tenantId, consultationId, key);
      if (existing) return this.replayIntent(existing, request);
    }

    const supportedKinds = await this.capability.supportedKinds(tenantId, consultationId);
    const { mime, maxSizeBytes } = this.policy(() =>
      validateIntent({ kind: request.kind, mime: request.mime, sizeBytes: request.sizeBytes, supportedKinds, sizes: this.sizeSettings(tenantId) }),
    );
    const bucket = await this.resolveBucket(request.kind);
    await this.withQuota(() => this.blobStorage.assertCanStore(bucket, request.sizeBytes));
    const encounterSeq = request.encounterSeq ?? (await this.lifecycleGate.currentEncounterSeq(consultationId));

    const now = new Date();
    const entity = ConsultationAttachmentFactory.CreateConsultationAttachment({
      tenantId,
      consultationId,
      encounterSeq,
      purpose: purpose === 'feedback' ? ConsultationAttachmentPurpose.FEEDBACK : ConsultationAttachmentPurpose.ATTACHMENT,
      kind: KIND_TO_ENUM[request.kind],
      declaredMime: mime,
      declaredSizeBytes: request.sizeBytes,
      declaredSha256: request.sha256,
      bucketName: bucket,
      objectKey: '',
      idempotencyKey: key ?? null,
      uploadExpiresAt: new Date(now.getTime() + this.uploadTtlSeconds() * 1000),
      intentExpiresAt: new Date(now.getTime() + this.numberSetting(INTENT_TTL_HOURS_KEY, null) * HOUR_MS),
      createdBy: this.requestUserId ?? undefined,
    });
    entity.objectKey = buildAttachmentObjectKey({ consultationId, attachmentId: entity.id, mime, purpose, now });
    if (request.fileName) {
      await encryptPhiFields(
        this.secretsService,
        'ConsultationAttachment fileName',
        () => this.attachmentRepository.encryptFileNameIntoEntity(entity, request.fileName, this.secretsService!),
        this.logger,
      );
    }

    const upload = await this.presign(entity, tenantId);
    entity.uploadMode = UPLOAD_MODE_COLUMN[upload.mode];

    let saved: ConsultationAttachmentEntity;
    try {
      saved = await this.attachmentRepository.create(entity);
    } catch (error) {
      if (!key || (error as { code?: string })?.code !== 'P2002') throw error;
      // Two intents raced on one key: the winner's row is the answer.
      const winner = await this.attachmentRepository.findByIdempotencyKey(tenantId, consultationId, key);
      if (winner) return this.replayIntent(winner, request);
      throw new ConflictException({
        code: ATTACHMENT_ERROR_CODES.IDEMPOTENCY_KEY_IN_FLIGHT,
        message: 'Another request with this Idempotency-Key is in progress.',
      });
    }

    if (purpose === 'attachment') await this.lifecycleGate.touchActivity(consultationId);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { consultationId, kind: request.kind, purpose, status: saved.status, uploadMode: upload.mode },
    });
    return this.toIntentResponse(saved, upload, maxSizeBytes);
  }

  private async replayIntent(existing: ConsultationAttachmentEntity, request: CreateAttachmentIntentRequest): Promise<AttachmentIntentResponse> {
    const purpose = request.purpose ?? 'attachment';
    const same =
      ENUM_TO_KIND[existing.kind] === request.kind &&
      existing.declaredMime === normalizeAttachmentMime(request.mime) &&
      existing.declaredSizeBytes === request.sizeBytes &&
      existing.declaredSha256 === request.sha256 &&
      this.purposeOf(existing) === purpose &&
      (request.encounterSeq === undefined || existing.encounterSeq === request.encounterSeq);
    if (!same) {
      throw new ConflictException({
        code: ATTACHMENT_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        message: 'This Idempotency-Key was already used for a different attachment.',
      });
    }
    if (existing.status === ConsultationAttachmentStatus.EXPIRED) throw this.intentExpired();
    if (existing.status !== ConsultationAttachmentStatus.INTENT) {
      throw new ConflictException({
        code: ATTACHMENT_ERROR_CODES.IDEMPOTENCY_KEY_IN_FLIGHT,
        message: 'The attachment for this Idempotency-Key is past its upload step; read it instead.',
        attachmentId: existing.id,
        status: existing.status,
      });
    }
    this.assertIntentOpen(existing);

    const upload = await this.presign(existing, existing.tenantId);
    if (upload.mode === 'presigned') {
      existing.uploadExpiresAt = new Date(Date.now() + this.uploadTtlSeconds() * 1000);
      await this.attachmentRepository.update(existing.id, existing);
    }
    const kind = ENUM_TO_KIND[existing.kind];
    return this.toIntentResponse(existing, upload, resolveMaxSizeBytes(kind, this.sizeSettings(existing.tenantId)));
  }

  /** A presigned PUT, or a gateway upload when the store cannot sign one and the file fits the multipart ceiling. */
  private async presign(
    row: ConsultationAttachmentEntity,
    tenantId: string,
  ): Promise<{ mode: AttachmentUploadMode; url: string | null; headers: Record<string, string> }> {
    try {
      const signed = await this.withQuota(() =>
        this.blobStorage.presignPutIntent({
          bucket: row.bucketName,
          key: row.objectKey,
          contentType: row.declaredMime,
          contentLength: row.declaredSizeBytes,
          checksumSha256: hexToBase64(row.declaredSha256),
          expiresSeconds: this.uploadTtlSeconds(),
        }),
      );
      return { mode: 'presigned', url: signed.url, headers: signed.headers };
    } catch (error) {
      if ((error as { name?: string })?.name !== 'StorageNotSupportedError') throw error;
      const multipartMaxBytes = this.multipartMaxBytes(tenantId);
      if (row.declaredSizeBytes > multipartMaxBytes) {
        throw this.toHttp(
          new AttachmentPolicyError(
            ATTACHMENT_ERROR_CODES.TOO_LARGE,
            413,
            'This store cannot take a direct upload and the file is above the gateway upload ceiling.',
            {
              maxSizeBytes: multipartMaxBytes,
            },
          ),
        );
      }
      return { mode: 'gateway', url: null, headers: { 'Content-Type': row.declaredMime, 'Content-Length': String(row.declaredSizeBytes) } };
    }
  }

  // ============================================================
  // Complete (presigned) and content (gateway)
  // ============================================================

  async complete(consultationId: string, attachmentId: string): Promise<AttachmentResponse> {
    const tenantId = this.requireTenant();
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    const row = await this.loadRow(consultationId, attachmentId, tenantId);
    if (row.status !== ConsultationAttachmentStatus.INTENT) return this.currentState(row);
    this.assertIntentOpen(row);
    if (this.purposeOf(row) === 'attachment') await this.lifecycleGate.assertContentWritable(consultationId);

    const head = await this.blobStorage.headObject(row.bucketName, row.objectKey);
    if (!head) {
      throw new ConflictException({
        code: ATTACHMENT_ERROR_CODES.NOT_UPLOADED,
        message: 'Nothing has been uploaded for this attachment yet; PUT the file, then complete.',
      });
    }
    if (row.kind === ConsultationAttachmentKind.AUDIO) await this.audio.preflight();
    if (!(await this.attachmentRepository.claimIntentToUploaded(row.id))) return this.currentState(await this.reload(row));

    const stored = await this.storedBytes(row, head);
    const doctorId = (consultation as { doctorId?: string | null }).doctorId ?? null;
    if (!head.checksumSha256 && head.sizeBytes > this.numberSetting(INLINE_VERIFY_MAX_MB_KEY, null) * MB) {
      await this.attachmentRepository.compareAndSetStatus(row.id, [ConsultationAttachmentStatus.UPLOADED], ConsultationAttachmentStatus.PROCESSING);
      await this.lifecycleGate.beginProcessing(consultationId, PROCESSING_ATTACHMENT, row.id);
      const accepted = this.toResponse(await this.reload(row));
      void this.verifyAndFinishInBackground(row, stored, doctorId);
      return accepted;
    }

    await this.verifyOrReject(row, stored, { presigned: true });
    await this.finish(row, stored, { presigned: true, processing: false, doctorId });
    return this.toResponse(await this.reload(row));
  }

  async uploadContent(consultationId: string, attachmentId: string, file: AttachmentContentUpload): Promise<AttachmentResponse> {
    const tenantId = this.requireTenant();
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    const row = await this.loadRow(consultationId, attachmentId, tenantId);
    if (row.status !== ConsultationAttachmentStatus.INTENT) return this.currentState(row);
    this.assertIntentOpen(row);
    if (this.purposeOf(row) === 'attachment') await this.lifecycleGate.assertContentWritable(consultationId);

    const body = file?.buffer;
    if (!body || body.length === 0) throw new BadRequestException({ code: 'ATTACHMENT_EMPTY', message: 'The uploaded file is empty.' });
    const multipartMaxBytes = this.multipartMaxBytes(tenantId);
    if (body.length > multipartMaxBytes) {
      throw this.toHttp(
        new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.TOO_LARGE, 413, 'The file is above the gateway upload ceiling; use the presigned upload.', {
          maxSizeBytes: multipartMaxBytes,
        }),
      );
    }
    if (row.kind === ConsultationAttachmentKind.AUDIO) await this.audio.preflight();
    if (!(await this.attachmentRepository.claimIntentToUploaded(row.id))) return this.currentState(await this.reload(row));

    const stored: StoredBytes = { size: body.length, head: body.subarray(0, TEXT_SNIFF_BYTES), body };
    // Verified in memory before anything is written: a refused body is never stored.
    await this.verifyOrReject(row, stored, { presigned: false, objectWritten: false });
    try {
      await this.withQuota(() => this.blobStorage.putObject({ bucket: row.bucketName, key: row.objectKey, body, contentType: row.declaredMime }));
    } catch (error) {
      await this.markFailed(row, error instanceof HttpException ? this.codeOf(error) : PROCESSING_FAILED);
      throw error;
    }
    await this.finish(row, stored, {
      presigned: false,
      processing: false,
      doctorId: (consultation as { doctorId?: string | null }).doctorId ?? null,
    });
    return this.toResponse(await this.reload(row));
  }

  // ============================================================
  // Reads
  // ============================================================

  async list(consultationId: string): Promise<AttachmentResponse[]> {
    const tenantId = this.requireTenant();
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    const rows = await this.attachmentRepository.findByConsultation(consultationId);
    return rows.filter((r) => r.tenantId === tenantId).map((r) => this.toResponse(r));
  }

  async get(consultationId: string, attachmentId: string): Promise<AttachmentResponse> {
    const tenantId = this.requireTenant();
    await assertParentInScope(this.consultationRepository, consultationId, tenantId);
    return this.toResponse(await this.loadRow(consultationId, attachmentId, tenantId));
  }

  // ============================================================
  // Verification
  // ============================================================

  private async storedBytes(row: ConsultationAttachmentEntity, head: BlobObjectHead): Promise<StoredBytes> {
    const size = head.sizeBytes;
    const sniff =
      size > 0 ? await this.blobStorage.getObjectRange(row.bucketName, row.objectKey, 0, Math.min(size, TEXT_SNIFF_BYTES) - 1) : Buffer.alloc(0);
    // A case note is read whole anyway (it becomes the item's text), so it is hashed in memory.
    const body =
      row.kind === ConsultationAttachmentKind.CASE_NOTE
        ? await this.blobStorage.getObject({ bucket: row.bucketName, key: row.objectKey })
        : undefined;
    return {
      size,
      head: sniff,
      body,
      storeChecksum: head.checksumSha256,
      stream: () => this.blobStorage.getObjectStream({ bucket: row.bucketName, key: row.objectKey }),
    };
  }

  /** Size, magic bytes, SHA-256 and (for a presigned write) the quota with the real size. Any refusal FAILs the row. */
  private async verifyOrReject(
    row: ConsultationAttachmentEntity,
    stored: StoredBytes,
    opts: { presigned: boolean; objectWritten?: boolean },
  ): Promise<void> {
    try {
      await this.verify(row, stored, opts.presigned);
    } catch (error) {
      if (!(error instanceof AttachmentRejection)) throw error;
      if (opts.objectWritten !== false) await this.deleteObjectBestEffort(row);
      await this.markFailed(row, error.code);
      throw error.http;
    }
  }

  private async verify(row: ConsultationAttachmentEntity, stored: StoredBytes, presigned: boolean): Promise<void> {
    const kind = ENUM_TO_KIND[row.kind];
    const maxSizeBytes = resolveMaxSizeBytes(kind, this.sizeSettings(row.tenantId));
    if (stored.size > maxSizeBytes) {
      this.reject(
        new AttachmentPolicyError(
          ATTACHMENT_ERROR_CODES.TOO_LARGE,
          413,
          `The file is ${stored.size} bytes; the maximum for a '${kind}' is ${maxSizeBytes}.`,
          { maxSizeBytes },
        ),
      );
    }
    if (stored.size !== row.declaredSizeBytes) {
      this.reject(
        new AttachmentPolicyError(
          ATTACHMENT_ERROR_CODES.CHECKSUM_MISMATCH,
          422,
          `The file is ${stored.size} bytes, not the declared ${row.declaredSizeBytes}.`,
        ),
      );
    }
    const matches = kind === 'audio' ? audioContentMatches(row.declaredMime, stored.head) : attachmentContentMatches(row.declaredMime, stored.head);
    if (!matches)
      this.reject(new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.CONTENT_MISMATCH, 415, `The file's content is not ${row.declaredMime}.`));
    if (kind === 'case_note') {
      try {
        this.caseNotes.assertText(stored.body ?? Buffer.alloc(0));
      } catch (error) {
        if (error instanceof AttachmentPolicyError) this.reject(error);
        throw error;
      }
    }
    const sha = await this.sha256Base64(stored);
    if (sha !== hexToBase64(row.declaredSha256)) {
      this.reject(new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.CHECKSUM_MISMATCH, 422, 'The file does not match the declared SHA-256.'));
    }
    if (presigned) {
      try {
        await this.withQuota(() => this.blobStorage.assertCanStore(row.bucketName, stored.size));
      } catch (error) {
        if (error instanceof HttpException) throw new AttachmentRejection(ATTACHMENT_ERROR_CODES.QUOTA_EXCEEDED, error);
        throw error;
      }
    }
  }

  /** The store's own checksum when it recorded one; otherwise the bytes in memory, or a streamed re-hash. */
  private async sha256Base64(stored: StoredBytes): Promise<string> {
    if (stored.storeChecksum) return stored.storeChecksum;
    if (stored.body) return createHash('sha256').update(stored.body).digest('base64');
    const hash = createHash('sha256');
    const stream = await stored.stream!();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('base64');
  }

  private reject(error: AttachmentPolicyError): never {
    throw new AttachmentRejection(error.code, this.toHttp(error));
  }

  // ============================================================
  // Dispatch
  // ============================================================

  private async verifyAndFinishInBackground(row: ConsultationAttachmentEntity, stored: StoredBytes, doctorId: string | null): Promise<void> {
    try {
      await this.verifyOrReject(row, stored, { presigned: true });
      await this.finish(row, stored, { presigned: true, processing: true, doctorId });
    } catch (error) {
      const code = error instanceof HttpException ? this.codeOf(error) : PROCESSING_FAILED;
      this.logger.warn({ message: 'Attachment background verification failed', attachmentId: row.id, consultationId: row.consultationId, code });
      await this.markFailed(row, code);
      // swallow-ok: the row is FAILED and the consultation's processing marker cleared; nobody awaits this.
      await this.lifecycleGate.endProcessing(row.consultationId, row.id, { failed: true, reason: code }).catch(() => undefined);
    }
  }

  /** `Media` row, then the kind's processor; READY, or PROCESSING when the result arrives later. */
  private async finish(
    row: ConsultationAttachmentEntity,
    stored: StoredBytes,
    opts: { presigned: boolean; processing: boolean; doctorId: string | null },
  ): Promise<void> {
    // A presigned PUT bypassed the gateway, so its bytes are added to the tenant's usage here.
    if (opts.presigned) await this.blobStorage.recordExternalWrite(row.bucketName, stored.size);
    const ext = attachmentExtension(row.declaredMime);
    const media = await this.mediaService.create({
      tenantId: row.tenantId,
      name: ext ? `${row.id}.${ext}` : row.id,
      uri: `s3://${row.bucketName}/${row.objectKey}`,
      extension: ext,
      mimeType: row.declaredMime,
      size: stored.size,
      hash: row.declaredSha256,
    });
    const mediaId = String(media.id);

    let outcome: AttachmentProcessOutcome;
    try {
      outcome =
        this.purposeOf(row) === 'feedback'
          ? { pending: false, contextItemId: null }
          : await this.dispatch(row, {
              consultationId: row.consultationId,
              attachmentId: row.id,
              mediaId,
              bucket: row.bucketName,
              key: row.objectKey,
              mime: row.declaredMime,
              doctorId: opts.doctorId,
              body: stored.body,
              encounterSeq: row.encounterSeq ?? (await this.lifecycleGate.currentEncounterSeq(row.consultationId)),
            });
    } catch (error) {
      await this.markFailed(row, error instanceof HttpException ? this.codeOf(error) : PROCESSING_FAILED, { mediaId });
      throw error;
    }

    const status = outcome.pending ? ConsultationAttachmentStatus.PROCESSING : ConsultationAttachmentStatus.READY;
    await this.attachmentRepository.compareAndSetStatus(row.id, IN_PROGRESS, status, {
      mediaId,
      contextItemId: outcome.contextItemId,
      ...(outcome.transcriptionJobId ? { transcriptionJobId: outcome.transcriptionJobId } : {}),
      ...(outcome.pending ? {} : { completedAt: new Date() }),
    });
    if (outcome.pending && !opts.processing) await this.lifecycleGate.beginProcessing(row.consultationId, PROCESSING_ATTACHMENT, row.id);
    if (!outcome.pending && opts.processing) await this.lifecycleGate.endProcessing(row.consultationId, row.id, undefined);
    if (this.purposeOf(row) === 'attachment') await this.lifecycleGate.touchActivity(row.consultationId);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: {
        consultationId: row.consultationId,
        kind: ENUM_TO_KIND[row.kind],
        status,
        mediaId,
        contextItemId: outcome.contextItemId,
        transcriptionJobId: outcome.transcriptionJobId ?? null,
      },
    });
  }

  private dispatch(row: ConsultationAttachmentEntity, input: AttachmentProcessInput): Promise<AttachmentProcessOutcome> {
    switch (row.kind) {
      case ConsultationAttachmentKind.CASE_NOTE:
        return this.caseNotes.process(input);
      case ConsultationAttachmentKind.IMAGE:
        return this.images.process(input);
      case ConsultationAttachmentKind.AUDIO:
        return this.audio.process(input);
      default:
        return this.documents.process(input);
    }
  }

  private async markFailed(row: ConsultationAttachmentEntity, failureCode: string, data: Record<string, unknown> = {}): Promise<void> {
    const won = await this.attachmentRepository.compareAndSetStatus(row.id, IN_PROGRESS, ConsultationAttachmentStatus.FAILED, {
      ...data,
      failureCode,
      completedAt: new Date(),
    });
    if (!won) return;
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: { consultationId: row.consultationId, kind: ENUM_TO_KIND[row.kind], status: ConsultationAttachmentStatus.FAILED, failureCode },
    });
  }

  private async deleteObjectBestEffort(row: ConsultationAttachmentEntity): Promise<void> {
    try {
      await this.blobStorage.deleteObject({ bucket: row.bucketName, key: row.objectKey });
    } catch (error) {
      // Never the key: it is ids-only, but the error message of a provider is not ours to trust.
      this.logger.warn({
        message: 'Could not delete a refused attachment object',
        attachmentId: row.id,
        error: (error as { name?: string })?.name ?? 'Error',
      });
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant context required');
    return tenantId;
  }

  private async loadRow(consultationId: string, attachmentId: string, tenantId: string): Promise<ConsultationAttachmentEntity> {
    const row = await this.attachmentRepository.findByIdOrNull(attachmentId);
    if (!row || row.tenantId !== tenantId || row.consultationId !== consultationId) {
      throw new NotFoundException(`Attachment '${attachmentId}' not found.`);
    }
    return row;
  }

  private async reload(row: ConsultationAttachmentEntity): Promise<ConsultationAttachmentEntity> {
    return (await this.attachmentRepository.findByIdOrNull(row.id)) ?? row;
  }

  /** A row past INTENT answers its current state; an EXPIRED one is 410. */
  private currentState(row: ConsultationAttachmentEntity): AttachmentResponse {
    if (row.status === ConsultationAttachmentStatus.EXPIRED) throw this.intentExpired();
    return this.toResponse(row);
  }

  private assertIntentOpen(row: ConsultationAttachmentEntity): void {
    if (row.intentExpiresAt.getTime() <= Date.now()) throw this.intentExpired();
  }

  private intentExpired(): GoneException {
    return new GoneException({ code: ATTACHMENT_ERROR_CODES.INTENT_EXPIRED, message: 'This upload intent has expired; create a new one.' });
  }

  private purposeOf(row: ConsultationAttachmentEntity): AttachmentPurpose {
    return row.purpose === ConsultationAttachmentPurpose.FEEDBACK ? 'feedback' : 'attachment';
  }

  private policy<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof AttachmentPolicyError) throw this.toHttp(error);
      throw error;
    }
  }

  private toHttp(error: AttachmentPolicyError): HttpException {
    return new HttpException({ code: error.code, message: error.message, ...error.details }, error.httpStatus);
  }

  private codeOf(error: HttpException): string {
    const body = error.getResponse();
    return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : PROCESSING_FAILED;
  }

  /** The storage quota refusal as the contract's 409 `QUOTA_EXCEEDED`. */
  private async withQuota<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof QuotaExceededException) {
        throw new ConflictException({ code: ATTACHMENT_ERROR_CODES.QUOTA_EXCEEDED, message: 'The tenant storage quota does not allow this file.' });
      }
      throw error;
    }
  }

  private async resolveBucket(kind: AttachmentKind): Promise<string> {
    const { purpose, slugs } = BUCKET_CASCADE[kind === 'audio' ? 'audio' : 'attachment'];
    let bucket = await this.tenantBuckets.getBucketByPurpose(purpose);
    for (const slug of slugs) {
      if (bucket) break;
      bucket = await this.tenantBuckets.getBucketBySlug(slug);
    }
    if (!bucket) {
      throw new ServiceUnavailableException({
        code: ATTACHMENT_ERROR_CODES.MEDIA_STORAGE_UNAVAILABLE,
        message: `This tenant has no ${kind === 'audio' ? 'audio' : 'attachment'} bucket to store the upload in. Configure one (purpose ${purpose}).`,
      });
    }
    return bucket.name;
  }

  private sizeSettings(tenantId: string): AttachmentSizeSettings {
    return {
      maxAttachmentSizeMb: this.numberSetting(MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY, tenantId),
      maxAudioSizeMb: this.numberSetting(MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY, tenantId),
      batchMaxFileSizeMb: this.numberSetting(BATCH_MAX_FILE_SIZE_MB_KEY, tenantId),
    };
  }

  private multipartMaxBytes(tenantId: string): number {
    return Math.floor(this.numberSetting(MULTIPART_MAX_MB_KEY, tenantId) * MB);
  }

  private uploadTtlSeconds(): number {
    return this.numberSetting(UPLOAD_URL_TTL_SECONDS_KEY, null);
  }

  /** The settings plane (tenant → SYSTEM → descriptor default); the declared default only when it cannot answer. */
  private numberSetting(key: string, tenantId: string | null): number {
    try {
      const value = this.settings.resolve<number>(key, tenantId).value;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    } catch (error) {
      this.logger.warn({
        message: 'Attachment setting unreadable; using its declared default',
        key,
        error: (error as { name?: string })?.name ?? 'Error',
      });
    }
    return SETTING_DEFAULTS[key];
  }

  private toIntentResponse(
    row: ConsultationAttachmentEntity,
    upload: { mode: AttachmentUploadMode; url: string | null; headers: Record<string, string> },
    maxSizeBytes: number,
  ): AttachmentIntentResponse {
    return {
      attachmentId: row.id,
      status: 'INTENT',
      kind: ENUM_TO_KIND[row.kind],
      uploadMode: upload.mode,
      uploadUrl: upload.url,
      uploadMethod: 'PUT',
      uploadHeaders: upload.headers as unknown as AttachmentUploadHeaders,
      uploadExpiresAt: row.uploadExpiresAt.toISOString(),
      intentExpiresAt: row.intentExpiresAt.toISOString(),
      maxSizeBytes,
    };
  }

  private toResponse(row: ConsultationAttachmentEntity): AttachmentResponse {
    return {
      attachmentId: row.id,
      status: row.status as AttachmentResponse['status'],
      kind: ENUM_TO_KIND[row.kind],
      mime: row.declaredMime,
      sizeBytes: row.declaredSizeBytes,
      sha256: row.declaredSha256,
      mediaId: row.mediaId ?? null,
      contextItemId: row.contextItemId ?? null,
      ...(row.transcriptionJobId ? { transcriptionJobId: row.transcriptionJobId } : {}),
      failureCode: row.failureCode ?? null,
    };
  }
}
