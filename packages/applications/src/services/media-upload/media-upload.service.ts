import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { MediaRepository, ResourceType, TenantBucketPurpose, generateId } from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IBlobStorageService } from '../baseServices/storage/IBlobStorageService';
import { CONTEXT_ATTACHMENT_MIME_TYPES, normalizeContextMimeType } from '../consultation-context-schema/context-schema-definition';
import { IMediaService } from '../media/media/IMediaService';
import {
  MEDIA_UPLOAD_DEFAULTS,
  MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY,
  MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY,
} from '../settings-registry/descriptors/media-upload.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { ITenantBucketService } from '../tenant-bucket/ITenantBucketService';
import { MediaUploadResponse } from './dto';
import { IMediaUploadService, MediaUploadCategory, MediaUploadInput } from './IMediaUploadService';

/** Bytes an attachment of each binary type must start with (the client-declared MIME type is never trusted alone). */
const SIGNATURES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** A text attachment is checked over its head only: a NUL byte there means it is not text. */
const TEXT_SNIFF_BYTES = 8192;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The tenant bucket cascade per category: a configured PURPOSE first, then the conventional slugs. */
const BUCKET_CASCADE: Readonly<Record<MediaUploadCategory, { purpose: TenantBucketPurpose; slugs: readonly string[] }>> = {
  attachment: { purpose: TenantBucketPurpose.ATTACHMENTS, slugs: ['attachments'] },
  // The cascade the batch-transcription upload and the TTS blob delivery already use.
  audio: { purpose: TenantBucketPurpose.AUDIO, slugs: ['recordings', 'audio'] },
};

const SIZE_KEYS: Readonly<Record<MediaUploadCategory, { key: string; fallback: number }>> = {
  attachment: { key: MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY, fallback: MEDIA_UPLOAD_DEFAULTS.maxAttachmentSizeMb },
  audio: { key: MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY, fallback: MEDIA_UPLOAD_DEFAULTS.maxAudioSizeMb },
};

/**
 * A safe object-key basename: the last path segment, every character outside `[A-Za-z0-9._-]`
 * replaced, at most 128 characters, never empty and never a dot-file.
 */
export function safeMediaFileName(originalName: string | undefined, extension: string): string {
  const base = (originalName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-128);
  return cleaned.length > 0 ? cleaned : `upload${extension ? `.${extension}` : ''}`;
}

/**
 * TASK-1038 (F1) — the tenant media upload behind `POST /media`.
 *
 * One file in, one `Media` row out, answered as the REFERENCE a run carries
 * (`{ mediaId, mime, sizeBytes, sha256 }`). The bytes go to the TENANT's own bucket through the
 * storage cascade — never a platform bucket: these are attachments and recordings, PHI by default,
 * and a tenant with no bucket is told so (503) rather than written somewhere it did not configure.
 * Every refusal (category, size, content, tenant) happens before anything is written; an object
 * whose `Media` row then fails is deleted again so storage never holds an unreferenced upload.
 * The row is written through `IMediaService.create`, which broadcasts its `ResourceCreated` audit.
 */
@Injectable()
export class MediaUploadService extends BaseService implements IMediaUploadService {
  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject(IMediaService) private readonly mediaService: IMediaService,
    private readonly mediaRepository: MediaRepository,
    @Inject(ITenantBucketService) private readonly tenantBuckets: ITenantBucketService,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    private readonly settings: TenantSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Media);
  }

  async upload(input: MediaUploadInput): Promise<MediaUploadResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant context required');

    const mime = normalizeContextMimeType(input.mimeType ?? '');
    this.assertCategory(input.category, mime);
    if (!input.buffer || input.buffer.length === 0) throw new BadRequestException({ code: 'MEDIA_EMPTY', message: 'The uploaded file is empty.' });

    const maxMb = this.maxSizeMb(input.category);
    if (input.buffer.length > maxMb * 1024 * 1024) {
      throw new PayloadTooLargeException({
        code: 'MEDIA_TOO_LARGE',
        message: `The file is ${(input.buffer.length / (1024 * 1024)).toFixed(1)} MB; the maximum for an ${input.category} is ${maxMb} MB.`,
      });
    }
    if (input.category === 'attachment') this.assertContentMatches(mime, input.buffer);

    const bucket = await this.resolveBucket(input.category);
    const extension = EXTENSIONS[mime] ?? (mime.split('/')[1] ?? '').replace(/[^a-z0-9]+/g, '').slice(0, 16);
    const name = safeMediaFileName(input.originalName, extension);
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/media/${generateId()}/${name}`;
    const sha256 = createHash('sha256').update(input.buffer).digest('hex');

    await this.blobStorage.putObject({ bucket, key, body: input.buffer, contentType: mime });
    let mediaId: string;
    try {
      const media = await this.mediaService.create({
        tenantId,
        name,
        uri: `s3://${bucket}/${key}`,
        extension,
        mimeType: mime,
        size: input.buffer.length,
        hash: sha256,
      });
      mediaId = String(media.id);
    } catch (error) {
      // swallow-ok: the cleanup is best-effort; the original error is what the caller must see.
      await this.blobStorage.deleteObject({ bucket, key }).catch(() => undefined);
      throw error;
    }

    return { mediaId, mime, sizeBytes: input.buffer.length, sha256 };
  }

  async getOwnedReference(mediaId: string): Promise<MediaUploadResponse> {
    const tenantId = this.tenantId;
    const media = tenantId ? await this.mediaRepository.findByIdOrNull(mediaId) : null;
    if (!media || media.tenantId !== tenantId) throw new NotFoundException(`Media '${mediaId}' not found.`);
    return { mediaId: String(media.id), mime: media.mimeType, sizeBytes: media.size, sha256: media.hash };
  }

  // ============================================================
  // Internals
  // ============================================================

  private assertCategory(category: MediaUploadCategory, mime: string): void {
    const allowed =
      category === 'attachment' ? (CONTEXT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime) : category === 'audio' && mime.startsWith('audio/');
    if (!allowed) {
      throw new BadRequestException({
        code: 'MEDIA_TYPE_UNSUPPORTED',
        message:
          category === 'attachment'
            ? `An attachment must be one of ${CONTEXT_ATTACHMENT_MIME_TYPES.join(', ')} (got ${mime || 'no type'}).`
            : `An audio upload must be an audio/* type (got ${mime || 'no type'}).`,
      });
    }
  }

  /** The configured ceiling in MB — the settings plane, falling back to the code default only when unreadable. */
  private maxSizeMb(category: MediaUploadCategory): number {
    const { key, fallback } = SIZE_KEYS[category];
    try {
      const value = this.settings.resolvePlatform<number>(key).value;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  }

  private assertContentMatches(mime: string, bytes: Buffer): void {
    const signature = SIGNATURES[mime];
    const matches = signature ? signature(bytes) : !bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0);
    if (!matches) {
      throw new BadRequestException({ code: 'MEDIA_CONTENT_MISMATCH', message: `The file's content is not ${mime}.` });
    }
  }

  private async resolveBucket(category: MediaUploadCategory): Promise<string> {
    const { purpose, slugs } = BUCKET_CASCADE[category];
    let bucket = await this.tenantBuckets.getBucketByPurpose(purpose);
    for (const slug of slugs) {
      if (bucket) break;
      bucket = await this.tenantBuckets.getBucketBySlug(slug);
    }
    if (!bucket) {
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_UNAVAILABLE',
        message: `This tenant has no ${category === 'audio' ? 'audio' : 'attachment'} bucket to store the upload in. Configure one (purpose ${purpose}).`,
      });
    }
    return bucket.name;
  }
}
