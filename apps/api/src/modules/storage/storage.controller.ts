import { IMediaService, IS3Service, ITenantBucketService, S3HealthService } from '@arcaai/applications';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  Inject,
  MaxFileSizeValidator,
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
import { CanCreate, CanDelete, CanRead, CanUpdate } from '../../decorators';
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

@ApiBearerAuth()
@ApiTags('storage')
@Controller('storage')
export class StorageController {
  constructor(
    @Inject(IS3Service)
    private readonly s3Service: IS3Service,
    @Inject(IMediaService) private readonly mediaService: IMediaService,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
    private readonly s3HealthService: S3HealthService,
  ) {}

  @Get('buckets')
  @ApiOperation({ summary: 'List all storage buckets' })
  @ApiResponse({ status: 200, description: 'List of all buckets', type: [BucketInfoResponse] })
  @CanRead('Storage')
  async listBuckets(): Promise<BucketInfoResponse[]> {
    return this.s3Service.listAllBuckets();
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
    await this.s3Service.createBucket(body.name);
    return { name: body.name, created: true };
  }

  @Delete('buckets/:name')
  @ApiOperation({ summary: 'Delete a storage bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiResponse({ status: 200, description: 'Bucket deleted', type: DeleteBucketResponse })
  @CanDelete('Storage')
  async deleteBucket(@Param('name') name: string): Promise<DeleteBucketResponse> {
    if (/[.]{2}|[/\\]/.test(name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    await this.s3Service.deleteBucket(name);
    return { name, deleted: true };
  }

  @Patch('buckets/:name')
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
  @ApiOperation({ summary: 'Get bucket info' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiResponse({ status: 200, description: 'Bucket info', type: BucketWithFilesResponse })
  @CanRead('Storage')
  async getBucket(@Param('name') name: string): Promise<BucketWithFilesResponse> {
    if (/[.]{2}|[/\\]/.test(name)) {
      throw new BadRequestException('Invalid bucket name');
    }
    const files = await this.s3Service.listFiles(name, '');
    return { name, files };
  }

  @Get('buckets/:name/files')
  @ApiOperation({ summary: 'List files in bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiQuery({ name: 'prefix', required: false, type: String, description: 'Path prefix filter' })
  @ApiResponse({ status: 200, description: 'List of files in bucket' })
  @CanRead('Storage')
  async listFiles(@Param('name') name: string, @Query('prefix') prefix?: string): Promise<unknown[]> {
    return this.s3Service.listFiles(name, prefix || '');
  }

  @Post('buckets/:name/files')
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

    const tenantBucket = await this.tenantBucketService.getBucketBySlug(bucketName);
    const resolvedBucketName = tenantBucket?.name ?? bucketName;

    await this.s3Service.putFile(resolvedBucketName, fileKey, file.buffer, file.mimetype);

    const response: FileUploadResponse = {
      key: fileKey,
      size: file.size,
      contentType: file.mimetype,
    };

    try {
      const bucket = tenantBucket ?? (await this.tenantBucketService.getBucketByName(resolvedBucketName));
      if (bucket) {
        const ext = fileKey.includes('.') ? fileKey.split('.').pop()! : '';
        const media = await this.mediaService.create({
          name: fileKey,
          uri: `s3://${resolvedBucketName}/${fileKey}`,
          extension: ext,
          mimeType: file.mimetype,
          size: file.size,
          hash: '',
        });
        response.mediaId = media.id;
      }
    } catch {
      // Media record creation is best-effort; do not fail the upload
    }

    return response;
  }

  @Get('buckets/:name/files/:key')
  @ApiOperation({ summary: 'Get file info with presigned download URL' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiParam({ name: 'key', description: 'File key/path', type: String })
  @ApiResponse({ status: 200, description: 'File info with presigned download URL', type: FileInfoResponse })
  @CanRead('Storage')
  async getFileInfo(@Param('name') bucketName: string, @Param('key') key: string): Promise<FileInfoResponse> {
    const url = await this.s3Service.signUrl(bucketName, key, 'get');
    return { key, url };
  }

  @Delete('buckets/:name/files/:key')
  @ApiOperation({ summary: 'Delete file from bucket' })
  @ApiParam({ name: 'name', description: 'Bucket name', type: String })
  @ApiParam({ name: 'key', description: 'File key/path', type: String })
  @ApiResponse({ status: 200, description: 'File deleted', type: DeleteFileResponse })
  @CanDelete('Storage')
  async deleteFile(@Param('name') bucketName: string, @Param('key') key: string): Promise<DeleteFileResponse> {
    await this.s3Service.deleteFile(bucketName, key);
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
