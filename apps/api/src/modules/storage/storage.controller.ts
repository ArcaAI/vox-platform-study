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
  @ApiResponse({ status: 200, description: 'List of all buckets', type: [BucketInfoResponse] })
  @CanRead('Storage')
  async listBuckets(): Promise<BucketInfoResponse[]> {
    // Tenant-scoped: only the caller's tenant-owned buckets. Using
    // s3Service.listAllBuckets() here would leak every physical bucket across
    // all tenants. `creationDate` maps from the tenant
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
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
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
    if (/[.]{2}|[/\\]/.test(fileKey)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }

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
    if (/[.]{2}|[/\\]/.test(key)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }
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
    if (/[.]{2}|[/\\]/.test(key)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }
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
