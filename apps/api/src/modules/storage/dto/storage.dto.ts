import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateBucketRequest {
  @ApiProperty({ description: 'Name of the bucket to create', example: 'my-bucket' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Bucket type', example: 'private' })
  @IsString()
  @IsOptional()
  type?: string;
}

export class CreateBucketResponse {
  @ApiProperty({ description: 'Name of the created bucket' })
  name!: string;

  @ApiProperty({ description: 'Whether the bucket was created' })
  created!: boolean;
}

export class UpdateBucketRequest {
  @ApiPropertyOptional({ description: 'Bucket description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsString()
  @IsOptional()
  resourceStatus?: string;
}

export class UpdateBucketResponse {
  @ApiProperty({ description: 'Bucket name' })
  name!: string;

  @ApiPropertyOptional({ description: 'Bucket description' })
  description?: string;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;
}

export class BucketInfoResponse {
  @ApiProperty({ description: 'Bucket name' })
  name!: string;

  @ApiPropertyOptional({ description: 'Bucket creation date' })
  creationDate?: string;
}

export class DeleteBucketResponse {
  @ApiProperty({ description: 'Bucket name' })
  name!: string;

  @ApiProperty({ description: 'Whether the bucket was deleted' })
  deleted!: boolean;
}

export class BucketWithFilesResponse {
  @ApiProperty({ description: 'Bucket name' })
  name!: string;

  @ApiProperty({ description: 'Files in the bucket', type: 'array', items: { type: 'object' } })
  files!: unknown[];
}

export class FileUploadResponse {
  @ApiProperty({ description: 'File key/path' })
  key!: string;

  @ApiProperty({ description: 'File size in bytes' })
  size!: number;

  @ApiProperty({ description: 'File content type' })
  contentType!: string;
}

export class FileInfoResponse {
  @ApiProperty({ description: 'File key/path' })
  key!: string;

  @ApiProperty({ description: 'Presigned download URL' })
  url!: string;
}

export class DeleteFileResponse {
  @ApiProperty({ description: 'Whether the file was deleted' })
  deleted!: boolean;

  @ApiProperty({ description: 'File key/path' })
  key!: string;
}
