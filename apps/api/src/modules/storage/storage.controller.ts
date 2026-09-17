import {
  IBlobStorageService,
  IMediaService,
  IS3Service,
  ITenantBucketService,
  ImageThumbnailService,
  S3HealthService,
  deriveThumbnailKey,
  isThumbnailableImageMimeType,
} from '@arcaai/applications';
import { isPlatformBucket } from '@arcaai/domains';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  Inject,
  Logger,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantOwnedResource } from '../../common';
import { CanCreate, CanDelete, CanRead, CanUpdate, RequiredScopes } from '../../decorators';
import {
  BucketInfoResponse,
  BucketWithFilesResponse,
  CreateBucketRequest,
  CreateBucketResponse,
  DeleteBucketResponse,
  DeleteFileResponse,
  FileInfoResponse,
  FileUploadResponse,
  UpdateBucketRequest,
  UpdateBucketResponse,
} from './dto';
import { assertSafeObjectKey } from './object-key.guard';

/** Lifetime of presigned download URLs (mirrors the S3 service default). */
const PRESIGNED_GET_EXPIRY_SECONDS = 3600;

@ApiBearerAuth()
@ApiTags('storage')
@Controller('storage')
// wires the `media:file:*` scopes, declared in the registry since
// its inception but never referenced by any route. Stronger of the pair at
// class level (see TranscriptionJobController for the reasoning).
@RequiredScopes('media:file:write')
export class StorageController {
  constructor(
    // Tenant-aware data plane: object create/list/presign/delete + bucket
    // create/delete route to the per-tenant provider (S3/MinIO or Azure).
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    // Retained only for bucket-metadata tags (`updateBucket`), an S3/MinIO
    // feature with no provider-agnostic equivalent.
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    @Inject(IMediaService) private readonly mediaService: IMediaService,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
    private readonly s3HealthService: S3HealthService,
    // Produces the downscaled WebP derivative stored on
    // image upload. Provided by StorageModule (no deps; wraps `sharp`).
    private readonly imageThumbnailService: ImageThumbnailService,
  ) {}

  private readonly logger = new Logger(StorageController.name);

  @Get('buckets')
  @ApiOperation({ summary: 'List all storage buckets' })
  @ApiQuery({
    name: 'includePhysical',
    required: false,
    type: Boolean,
    description:
      'Storage browser "All tenants" view (TASK-932): merge every tenant\'s registered buckets with the physical bucket list from the provider. Allowed ONLY for an unscoped platform admin (no tenant context) — every other caller gets 400.',
  })
  @ApiResponse({ status: 200, description: 'List of all buckets', type: [BucketInfoResponse] })
  @ApiResponse({ status: 400, description: 'includePhysical requires an unscoped platform admin (no tenant context)' })
  @CanRead('Storage')
  async listBuckets(@Query('includePhysical') includePhysical?: string): Promise<BucketInfoResponse[]> {
    if (includePhysical === 'true') {
      const buckets = await this.tenantBucketService.listBucketsCrossTenantWithPhysical();
      return buckets.map((bucket) => ({
        name: bucket.name,
        creationDate: bucket.creationDate,
        tenantId: bucket.tenantId,
        tenantName: bucket.tenantName,
        registered: bucket.registered,
        physicalMissing: bucket.physicalMissing,
        platform: bucket.platform,
      }));
    }

    // Tenant-scoped: only the caller's tenant-owned buckets (an unscoped
    // SUPER_ADMIN gets every tenant's rows — see
    // `TenantBucketService.listBuckets`). `creationDate` maps from the tenant
    // bucket record's createdAt; physical-only fields are not surfaced here.
    const buckets = await this.tenantBucketService.listBuckets();
    return buckets.map((bucket) => ({ name: bucket.name, creationDate: bucket.createdAt }));
  }

  @Post('buckets')
  @ApiOperation({ summary: 'Create a new storage bucket' })
  @ApiResponse({ status: 201, description: 'Bucket created', type: CreateBucketResponse })
  @CanCreate('Storage')
  async createBucket(@Body() body: CreateBucketRequest): Promise<CreateBucketResponse> {
    if (!body.name?.trim()) {
      throw new BadRequestException('Bucket name is required');
    }
    if (/[.]{2}|[/\\]/.test(body.name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    // A platform NAME cannot be CREATED here — the bucket already exists, so
    // this would be a no-op at best. TASK-967 made platform buckets manageable,
    // and the route for that is adoption, which is registry-only and leaves the
    // bucket untouched. Rejected BEFORE `createBucket`: creating first would
    // leave an untracked physical bucket behind if registration then threw.
    if (isPlatformBucket(body.name)) {
      throw new BadRequestException(
        `'${body.name.trim()}' is a platform bucket that already exists. Register it instead: POST admin/tenants/storage/buckets/register.`,
      );
    }
    await this.blobStorage.createBucket(body.name);
    // Register the TenantBucket row so the bucket is owned by the caller's
    // tenant and addressable by name on the GET/PATCH/DELETE routes (which
    // resolve via @TenantOwnedResource('TenantBucket')). Without this the
    // bucket exists in S3 but 404s on every management call.
    await this.tenantBucketService.registerBucket(body.name);
    return { name: body.name, created: true };
  }

  @Delete('buckets/:name')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Delete a storage bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiResponse({ status: 200, description: 'Bucket deleted', type: DeleteBucketResponse })
  @CanDelete('Storage')
  async deleteBucket(@Param('name') name: string): Promise<DeleteBucketResponse> {
    if (/[.]{2}|[/\\]/.test(name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    await this.blobStorage.deleteBucket(name);
    return { name, deleted: true };
  }

  @Patch('buckets/:name')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Update bucket metadata' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiResponse({ status: 200, description: 'Bucket metadata updated', type: UpdateBucketResponse })
  @CanUpdate('Storage')
  async updateBucket(@Param('name') name: string, @Body() body: UpdateBucketRequest): Promise<UpdateBucketResponse> {
    if (/[.]{2}|[/\\]/.test(name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    return this.s3Service.updateBucket(name, body);
  }

  @Get('buckets/:name')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Get bucket info' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiResponse({ status: 200, description: 'Bucket info', type: BucketWithFilesResponse })
  @CanRead('Storage')
  async getBucket(@Param('name') name: string): Promise<BucketWithFilesResponse> {
    if (/[.]{2}|[/\\]/.test(name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    const { objects: files } = await this.blobStorage.listObjects({ bucket: name });
    return { name, files };
  }

  @Get('buckets/:name/files')
  // scope: 'super-admin' (TASK-932 Lane T) lets the storage browser's "All
  // tenants" view (an unscoped platform admin — no working tenant) list files
  // in ANY registered bucket by name, mirroring the same bypass already used
  // by `TenantBucketController#listObjects` (`GET
  // admin/tenants/storage/buckets/:id/objects`). A tenant-bound caller
  // (working tenant selected, or a tenant admin) is unaffected: the interceptor
  // still runs the normal ownership assertion whenever a CLS tenant is present.
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name', scope: 'super-admin' })
  @ApiOperation({ summary: 'List files in bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiQuery({ name: 'prefix', required: false, type: String, description: 'Path prefix filter' })
  @ApiResponse({ status: 200, description: 'List of files in bucket' })
  @CanRead('Storage')
  async listFiles(@Param('name') name: string, @Query('prefix') prefix?: string): Promise<unknown[]> {
    const { objects } = await this.blobStorage.listObjects({ bucket: name, prefix: prefix || undefined });
    return objects;
  }

  @Post('buckets/:name/files')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Upload file to bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'File uploaded', type: FileUploadResponse })
  @UseInterceptors(FileInterceptor('file'))
  @CanCreate('Storage')
  async uploadFile(
    @Param('name') bucketName: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 100 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^(audio|video|application|text|image)\// }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Query('key') key?: string,
  ): Promise<FileUploadResponse> {
    const fileKey = key || file.originalname;
    assertSafeObjectKey(fileKey);

    // The route is @TenantOwnedResource-guarded on :name, so `bucketName` is an
    // already-validated, tenant-owned PHYSICAL bucket. Resolve the record by
    // physical name and 404 when absent — never resolve by slug or fall back to
    // the raw param, which could route the upload to an unintended bucket.
    const bucket = await this.tenantBucketService.getBucketByName(bucketName);
    if (!bucket) {
      throw new NotFoundException(`Bucket '${bucketName}' not found`);
    }

    await this.blobStorage.putObject({
      bucket: bucketName,
      key: fileKey,
      body: file.buffer,
      contentType: file.mimetype,
    });

    // For image uploads, also store a real downscaled
    // WebP derivative at the deterministic derived key (`<key>.thumb.webp`) so
    // the context timeline can presign a genuinely smaller thumbnail without any
    // schema change. Best-effort: a thumbnail failure must never fail the upload.
    if (isThumbnailableImageMimeType(file.mimetype)) {
      try {
        const thumbnail = await this.imageThumbnailService.generateWebpThumbnail(file.buffer);
        await this.blobStorage.putObject({
          bucket: bucketName,
          key: deriveThumbnailKey(fileKey),
          body: thumbnail,
          contentType: 'image/webp',
        });
      } catch (error) {
        this.logger.warn(
          `failed to generate/store thumbnail for ${bucketName}/${fileKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const response: FileUploadResponse = {
      key: fileKey,
      size: file.size,
      contentType: file.mimetype,
    };

    try {
      const ext = fileKey.includes('.') ? fileKey.split('.').pop()! : '';
      const media = await this.mediaService.create({
        name: fileKey,
        uri: `s3://${bucketName}/${fileKey}`,
        extension: ext,
        mimeType: file.mimetype,
        size: file.size,
        hash: '',
      });
      response.mediaId = media.id;
    } catch {
      // Media record creation is best-effort; do not fail the upload
    }

    return response;
  }

  @Get('buckets/:name/files/:key')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Get file info with presigned download URL' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiParam({ name: 'key', description: 'File key/path', type: String })
  @ApiResponse({ status: 200, description: 'File info with presigned download URL', type: FileInfoResponse })
  @CanRead('Storage')
  async getFileInfo(@Param('name') bucketName: string, @Param('key') key: string): Promise<FileInfoResponse> {
    assertSafeObjectKey(key);
    const url = await this.blobStorage.presignGet({ bucket: bucketName, key, expiresInSeconds: PRESIGNED_GET_EXPIRY_SECONDS });
    return { key, url };
  }

  @Delete('buckets/:name/files/:key')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
  @ApiOperation({ summary: 'Delete file from bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiParam({ name: 'key', description: 'File key/path', type: String })
  @ApiResponse({ status: 200, description: 'File deleted', type: DeleteFileResponse })
  @CanDelete('Storage')
  async deleteFile(@Param('name') bucketName: string, @Param('key') key: string): Promise<DeleteFileResponse> {
    assertSafeObjectKey(key);
    await this.blobStorage.deleteObject({ bucket: bucketName, key });
    return { deleted: true, key };
  }

  @Get('health')
  @ApiOperation({ summary: 'Check storage service health (detailed)' })
  @ApiResponse({ status: 200, description: 'Detailed storage health status' })
  @CanRead('Storage')
  async checkHealth() {
    const health = await this.s3HealthService.checkHealth();
    return {
      status: health.status,
      connected: health.details.connected ?? false,
      isMinIO: health.details.isMinIO ?? false,
      configured: health.details.configured,
      endpoint: health.details.endpoint,
      publicBucket: health.details.publicBucket,
      privateBucket: health.details.privateBucket,
      error: health.details.error,
    };
  }
}
