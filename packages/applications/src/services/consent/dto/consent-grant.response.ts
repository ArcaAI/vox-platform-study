import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentGrantMethod, ConsentPurpose, ResourceStatusType } from '@arcaai/domains';

export class ConsentGrantResponse {
  @ApiProperty({ description: 'Consent grant ID' })
  id!: string;

  @ApiProperty({ description: 'External patient identifier' })
  externalPatientId!: string;

  @ApiProperty({ description: 'Purpose-of-use this grant authorizes', enum: ConsentPurpose })
  purpose!: ConsentPurpose;

  @ApiPropertyOptional({ description: 'Minimum-necessary scope bag' })
  scope?: Record<string, unknown>;

  @ApiProperty({ description: 'When the grant was given' })
  grantedAt!: string;

  @ApiProperty({ description: 'Recording user id' })
  grantedBy!: string;

  @ApiProperty({ description: 'How the grant was captured', enum: ConsentGrantMethod })
  grantMethod!: ConsentGrantMethod;

  @ApiPropertyOptional({ description: 'Object-store pointer to the signed/recorded evidence artifact' })
  evidenceRef?: string;

  @ApiPropertyOptional({ description: 'Grant expiry' })
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'When the grant was revoked, if it was' })
  revokedAt?: string;

  @ApiPropertyOptional({ description: 'Who revoked the grant' })
  revokedBy?: string;

  @ApiPropertyOptional({ description: 'Why the grant was revoked' })
  revocationReason?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt!: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: string;

  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `expectedVersion` on revoke.',
    example: 1,
  })
  version!: number;
}
