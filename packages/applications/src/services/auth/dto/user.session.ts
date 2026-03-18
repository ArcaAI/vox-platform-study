import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { EntityIdProperty } from '../../../decorators';

export class UserSession {
    @EntityIdProperty()
    id: string;

    @ApiProperty()
    @IsString()
    @IsOptional()
    firstName?: string | null;

    @ApiProperty()
    @IsString()
    @IsOptional()
    lastName?: string | null;

    @ApiProperty()
    @IsString()
    email!: string;

    @ApiProperty()
    @IsString()
    @IsOptional()
    phone?: string | null;

    @ApiProperty()
    @IsString()
    @IsOptional()
    tenantId?: string | null;

    @ApiProperty()
    @IsString()
    @IsOptional()
    tenantCode?: string | null;

    @ApiProperty()
    @IsString()
    @IsOptional()
    token?: string | null;

    @ApiProperty({ type: [String] })
    @IsArray()
    @IsOptional()
    roles?: string[];

    @ApiProperty({ type: [String] })
    @IsArray()
    @IsOptional()
    permissions?: string[];

    constructor(init: UserSession) {
        this.id = init.id;
        this.firstName = init.firstName;
        this.lastName = init.lastName;
        this.email = init.email;
        this.phone = init.phone;
        this.tenantId = init.tenantId;
        this.tenantCode = init.tenantCode;
        this.token = init.token;
        this.roles = init.roles || [];
        this.permissions = init.permissions || [];
    }
}
