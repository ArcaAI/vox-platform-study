import {
  CONTEXT_ATTACHMENT_MIME_TYPES,
  IMediaUploadService,
  MEDIA_AUDIO_MIME_TYPES,
  MEDIA_UPLOAD_HARD_CEILING_MB,
  MediaUploadResponse,
  normalizeContextMimeType,
  type MediaUploadCategory,
} from '@arcaai/applications';
import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanCreate, CanRead, RequiredScopes, RequiredSvcScopes } from '../../decorators';

/**
 * The STATIC multipart ceiling: a decorator is evaluated once and cannot read the
 * `media.upload.*` settings, so this only stops a body far beyond any configurable limit from being
 * buffered before the service applies the CONFIGURED one. One file per request.
 */
export const MEDIA_UPLOAD_MULTIPART_LIMITS = { fileSize: MEDIA_UPLOAD_HARD_CEILING_MB * 1024 * 1024, files: 1 } as const;

/**
 * Which allow-list a MIME type belongs to: an attachment, the audio list, or neither. TASK-1038 E2
 * (fix 15) — the audio list is the SERVICE's own (`MEDIA_AUDIO_MIME_TYPES`), so the route and the
 * service can never disagree about what an audio upload is.
 */
function categoryOf(mimeType: string | undefined): MediaUploadCategory | null {
  const raw = (mimeType ?? '').trim().toLowerCase();
  if ((CONTEXT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalizeContextMimeType(raw))) return 'attachment';
  if (MEDIA_AUDIO_MIME_TYPES.has(raw)) return 'audio';
  return null;
}

/**
 * TASK-1038 (F1) — the tenant MEDIA upload plane, mounted at `/media` (→ `/api/v1/media`).
 *
 * Upload one attachment or audio file into the tenant's own bucket and get back the `mediaId` a run
 * references — a sandbox run's `attachments: [{ mediaId }]`, a business run's DOCUMENT / IMAGE kind
 * (`{ mediaId, mime }`), an audio blob kind. Bytes never come back out through this plane, and the
 * response never carries a bucket, a key or a URI.
 *
 * Both machine credential classes reach it (`media:write` / `svc:media:write`), alongside a JWT
 * holding `create:Media` (`read:Media` for the reference read). The admin console's Test tab calls
 * the SAME route through its BFF proxy (`/api/hope/media`, `X-Tenant-Id` attached) — no admin twin:
 * the route is already tenant-scoped by CLS, a tenant admin holds `manage:Media`, and a super admin
 * acting on a working tenant reaches it exactly like every other business-plane call.
 */
@ApiBearerAuth()
@ApiTags('storage')
@Controller('media')
export class MediaController {
  constructor(@Inject(IMediaUploadService) private readonly uploads: IMediaUploadService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CanCreate('Media')
  @RequiredScopes('media:write')
  @RequiredSvcScopes('svc:media:write')
  @UseInterceptors(FileInterceptor('file', { limits: MEDIA_UPLOAD_MULTIPART_LIMITS }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: "Upload an attachment or an audio file into the tenant's media store",
    description:
      'Multipart, one `file`. Attachments: text/plain, text/markdown, application/pdf, image/jpeg (image/jpg), image/png, image/webp — ' +
      'the content must match the type. Audio: the types the batch-transcription upload accepts. The size ceilings are platform settings ' +
      '(`media.upload.maxAttachmentSizeMb`, `media.upload.maxAudioSizeMb`). The bytes go to the tenant’s own attachment / audio bucket. ' +
      'Reference the returned `mediaId` from a run.',
  })
  @ApiResponse({ status: 201, type: MediaUploadResponse, description: '`{ mediaId, mime, sizeBytes, sha256 }`.' })
  @ApiResponse({
    status: 400,
    description:
      'No file, an empty file, a type on neither allow-list (`MEDIA_TYPE_UNSUPPORTED`), or content that is not the declared type (`MEDIA_CONTENT_MISMATCH`).',
  })
  @ApiResponse({ status: 403, description: 'Scope or ability violation.' })
  @ApiResponse({ status: 413, description: '`MEDIA_TOO_LARGE` — over the configured ceiling for its category.' })
  @ApiResponse({ status: 503, description: '`MEDIA_STORAGE_UNAVAILABLE` — the tenant has no attachment / audio bucket configured.' })
  async upload(@UploadedFile() file: Express.Multer.File): Promise<MediaUploadResponse> {
    if (!file?.buffer) throw new BadRequestException({ code: 'MEDIA_FILE_REQUIRED', message: 'A multipart `file` is required.' });
    const category = categoryOf(file.mimetype);
    if (!category) {
      throw new BadRequestException({
        code: 'MEDIA_TYPE_UNSUPPORTED',
        message: `Unsupported type ${file.mimetype || '(none)'}: upload an attachment (${CONTEXT_ATTACHMENT_MIME_TYPES.join(', ')}) or an audio file.`,
      });
    }
    return this.uploads.upload({ category, buffer: file.buffer, mimeType: file.mimetype, originalName: file.originalname });
  }

  @Get(':mediaId')
  @CanRead('Media')
  @RequiredScopes('media:write')
  @RequiredSvcScopes('svc:media:write')
  @ApiOperation({
    summary: 'Read back the reference of one media object',
    description: 'The same `{ mediaId, mime, sizeBytes, sha256 }` the upload answered. Never the bytes, a URL or the storage location.',
  })
  @ApiParam({ name: 'mediaId' })
  @ApiResponse({ status: 200, type: MediaUploadResponse })
  @ApiResponse({ status: 403, description: 'Scope or ability violation.' })
  @ApiResponse({ status: 404, description: 'Another tenant’s media, or an unknown id — one answer.' })
  async getReference(@Param('mediaId') mediaId: string): Promise<MediaUploadResponse> {
    return this.uploads.getOwnedReference(mediaId);
  }
}
