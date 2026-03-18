import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class MeResponse {
    @ApiProperty()
    @IsString()
    id: string;

    @ApiProperty()
    @IsString()
    username: string;

    @ApiProperty()
    @IsString()
    email: string;

    // @ApiProperty({ required: false })
    // @IsOptional()
    // @IsString()
    // firstName?: string;

    // @ApiProperty({ required: false })
    // @IsOptional()
    // @IsString()
    // lastName?: string;

    // @ApiProperty({ required: false })
    // @IsOptional()
    // @IsString()
    // phone?: string;

    @ApiProperty({ type: [String] })
    @IsArray()
    roles: string[];

    @ApiProperty({ type: [String] })
    @IsArray()
    permissions: string[];

    // @ApiProperty({ required: false })
    // @IsOptional()
    // @IsString()
    // tenantId?: string;

    // @ApiProperty({ required: false })
    // @IsOptional()
    // @IsString()
    // tenantCode?: string;

    constructor(init: Partial<MeResponse>) {
        this.id = init.id!;
        this.username = init.username!;
        this.email = init.email!;
        // this.firstName = init.firstName;
        // this.lastName = init.lastName;
        // this.phone = init.phone;
        this.roles = init.roles || [];
        this.permissions = init.permissions || [];
        // this.tenantId = init.tenantId;
        // this.tenantCode = init.tenantCode;
    }
}