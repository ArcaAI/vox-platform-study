import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class ImpersonateRequest {
    @ApiProperty({
        description: 'ID of the user to impersonate',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsString()
    @IsNotEmpty({ message: 'Target user ID is required' })
    targetUserId: string;
}

export class ImpersonateUserResponse {
    @ApiProperty()
    id: string;

    @ApiProperty()
    username: string;

    @ApiProperty()
    email: string;

    @ApiProperty({ type: [String] })
    roles: string[];

    @ApiProperty({ type: [String] })
    permissions: string[];

    @ApiProperty({ description: 'Tenant ID of the impersonated user', required: false })
    tenantId?: string;

    constructor(init: { id: string; username: string; email: string; roles: string[]; permissions: string[]; tenantId?: string }) {
        this.id = init.id;
        this.username = init.username;
        this.email = init.email;
        this.roles = init.roles;
        this.permissions = init.permissions;
        this.tenantId = init.tenantId;
    }
}

export class ImpersonateResponse {
    @ApiProperty({ type: ImpersonateUserResponse })
    user: ImpersonateUserResponse;

    @ApiProperty({
        description: 'Scoped JWT token for the impersonated user',
    })
    @IsString()
    token: string;

    @ApiProperty({
        description: 'ID of the admin who initiated the impersonation',
    })
    @IsString()
    impersonatedBy: string;
}
