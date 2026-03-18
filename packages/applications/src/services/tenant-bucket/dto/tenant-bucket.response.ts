import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantBucketType, ResourceStatusType } from '@arcaai/domains';

export class TenantBucketResponse {
    @ApiProperty({ description: 'Bucket ID' })
    id: string;

    @ApiProperty({ description: 'Tenant ID' })
    tenantId: string;

    @ApiProperty({ description: 'Physical S3 bucket name' })
    name: string;

    @ApiProperty({ description: 'Logical bucket slug', example: 'audio_recordings' })
    slug: string;

    @ApiPropertyOptional({ description: 'Bucket description' })
    description?: string;

    @ApiProperty({ description: 'Bucket type', enum: TenantBucketType })
    bucketType: TenantBucketType;

    @ApiProperty({ description: 'Path pattern for file organization' })
    pathPattern: string;

    @ApiProperty({ description: 'Whether this is a system bucket' })
    isSystemBucket: boolean;

    @ApiPropertyOptional({ description: 'Resource status', enum: ResourceStatusType })
    resourceStatus?: ResourceStatusType;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;

    @ApiProperty({ description: 'Last update timestamp' })
    updatedAt: string;
}
