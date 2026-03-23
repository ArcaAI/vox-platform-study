import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PermissionDetail {
    @ApiProperty({ description: 'Permission action', example: 'read' })
    action!: string;

    @ApiProperty({ description: 'Permission subject', example: 'User' })
    subject!: string;

    @ApiPropertyOptional({ description: 'Permission conditions' })
    conditions?: unknown;
}

export class MyPermissionsResponse {
    @ApiProperty({ description: 'User ID' })
    userId!: string;

    @ApiPropertyOptional({ description: 'Tenant ID context' })
    tenantId?: string;

    @ApiProperty({ description: 'Effective permissions', type: [PermissionDetail] })
    permissions!: PermissionDetail[];
}

export class AssignPolicyResponse {
    @ApiProperty({ description: 'Result message' })
    message!: string;
}
