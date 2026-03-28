import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type TenantBucketTreeNodeType = 'folder' | 'file';

export class TenantBucketTreeNodeResponse {
  @ApiProperty({ description: 'Unique node ID for tree rendering' })
  id: string;

  @ApiProperty({ description: 'Display name of file or folder' })
  name: string;

  @ApiProperty({ description: 'Node type', enum: ['folder', 'file'] })
  type: TenantBucketTreeNodeType;

  @ApiProperty({ description: 'Absolute object path from bucket root' })
  path: string;

  @ApiPropertyOptional({ description: 'File size in bytes (files only)' })
  size?: number;

  @ApiPropertyOptional({
    description: 'Last modified timestamp (files only, ISO string)',
  })
  lastModified?: string;

  @ApiPropertyOptional({
    type: () => TenantBucketTreeNodeResponse,
    isArray: true,
    description: 'Child nodes (folders only)',
  })
  children?: TenantBucketTreeNodeResponse[];
}

export class TenantBucketTreeResponse {
  @ApiProperty({ description: 'Bucket ID' })
  bucketId: string;

  @ApiProperty({ description: 'Physical bucket name' })
  bucketName: string;

  @ApiProperty({
    description: 'Tree root path used as the listing prefix',
    example: 'patients/2026/',
  })
  rootPath: string;

  @ApiProperty({
    type: () => TenantBucketTreeNodeResponse,
    isArray: true,
    description: 'Top-level tree nodes under the selected root path',
  })
  nodes: TenantBucketTreeNodeResponse[];
}
