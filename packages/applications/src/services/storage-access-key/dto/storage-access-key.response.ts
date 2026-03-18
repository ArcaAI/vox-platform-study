import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StorageAccessKeyResponse {
    @ApiProperty({ description: 'Key ID' })
    id: string;

    @ApiProperty({ description: 'Tenant ID' })
    tenantId: string;

    @ApiProperty({ description: 'Key name' })
    name: string;

    @ApiPropertyOptional({ description: 'Key description' })
    description?: string;

    @ApiProperty({ description: 'Access key ID (public identifier)' })
    accessKeyId: string;

    @ApiProperty({ description: 'Permissions granted to this key' })
    permissions: string[];

    @ApiProperty({ description: 'Bucket IDs this key can access (empty = all)' })
    bucketIds: string[];

    @ApiPropertyOptional({ description: 'Key expiration date' })
    expiresAt?: string;

    @ApiPropertyOptional({ description: 'Last used timestamp' })
    lastUsedAt?: string;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;
}

export class StorageAccessKeyWithSecretResponse extends StorageAccessKeyResponse {
    @ApiProperty({ description: 'Secret access key (only shown on creation)' })
    secretAccessKey: string;
}
