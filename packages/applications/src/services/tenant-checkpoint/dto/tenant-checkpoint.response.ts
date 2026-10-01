import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';

export class CheckpointProgressResponse {
  @ApiProperty({ example: 'tables' }) phase!: string;
  @ApiProperty({ example: 12 }) tablesDone!: number;
  @ApiProperty({ example: 140 }) tablesTotal!: number;
  @ApiProperty({ example: 1048576 }) bytesWritten!: number;
}

export class TenantCheckpointResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['MANUAL', 'SAFETY'] }) kind!: 'MANUAL' | 'SAFETY';
  @ApiProperty({ enum: ['CREATED', 'UPLOADED'] }) origin!: 'CREATED' | 'UPLOADED';
  @ApiProperty({ enum: ['PENDING', 'UPLOADING', 'RUNNING', 'READY', 'FAILED', 'CANCELLED'] })
  status!: 'PENDING' | 'UPLOADING' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED';
  @ApiProperty() includesMedia!: boolean;
  @ApiProperty() passphraseProtected!: boolean;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
  @ApiProperty({ type: CheckpointProgressResponse, nullable: true }) progress!: CheckpointProgressResponse | null;
  @ApiProperty({ description: 'ISO-8601' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601' }) expiresAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601' }) heartbeatAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureDetail!: string | null;
  @ApiProperty({ description: 'Row version (also the ETag)' }) version!: number;
}

export class PaginatedTenantCheckpointResponse extends PaginatedResponse<TenantCheckpointResponse> {
  @ApiProperty({ type: [TenantCheckpointResponse] })
  override readonly data!: readonly TenantCheckpointResponse[];
}

export class RestoreCountResponse {
  @ApiProperty() model!: string;
  @ApiProperty() inserted!: number;
  @ApiProperty() updated!: number;
  @ApiProperty() retired!: number;
}

export class RestoreWarningResponse {
  @ApiProperty({ example: 'IMMUTABLE_DIVERGED' }) code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) detail?: Record<string, unknown>;
}

export class TenantCheckpointRestoreResponse {
  @ApiProperty() id!: string;
  @ApiProperty() checkpointId!: string;
  @ApiProperty({ enum: ['CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL'], isArray: true }) categories!: ('CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL')[];
  @ApiProperty() reason!: string;
  @ApiProperty({
    enum: ['PENDING', 'LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true }) safetyCheckpointId!: string | null;
  @ApiProperty({ type: [RestoreCountResponse], nullable: true }) counts!: RestoreCountResponse[] | null;
  @ApiProperty({ type: [RestoreWarningResponse] }) warnings!: RestoreWarningResponse[];
  @ApiProperty() requestedBy!: string;
  @ApiProperty({ description: 'ISO-8601' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601' }) lockAcquiredAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601' }) lockReleasedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureDetail!: string | null;
  @ApiProperty({ description: 'Row version (also the ETag)' }) version!: number;
}

export class PaginatedTenantCheckpointRestoreResponse extends PaginatedResponse<TenantCheckpointRestoreResponse> {
  @ApiProperty({ type: [TenantCheckpointRestoreResponse] })
  override readonly data!: readonly TenantCheckpointRestoreResponse[];
}

export class CheckpointDownloadUrlResponse {
  @ApiProperty({ description: 'Presigned GET URL; valid for 15 minutes' }) url!: string;
  @ApiProperty({ description: 'ISO-8601' }) expiresAt!: string;
  @ApiProperty({ example: 'acme-20261001-1200-0a1b2c3d.hcp' }) filename!: string;
}

export class UploadPartTargetResponse {
  @ApiProperty({ minimum: 1 }) partNumber!: number;
  @ApiProperty({ description: 'Presigned PUT URL for this part' }) url!: string;
}

export class InitCheckpointUploadResponse {
  @ApiProperty({ type: TenantCheckpointResponse }) checkpoint!: TenantCheckpointResponse;
  @ApiProperty({ description: 'Multipart upload id; accepted by the complete and abort routes' }) uploadId!: string;
  @ApiProperty({ description: 'Slice the file into parts of exactly this size (the last may be smaller)' }) partSizeBytes!: number;
  @ApiProperty({ type: [UploadPartTargetResponse] }) parts!: UploadPartTargetResponse[];
  @ApiProperty({ description: 'ISO-8601; the part URLs stop working at this time' }) expiresAt!: string;
}
