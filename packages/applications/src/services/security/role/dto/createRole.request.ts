import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateRoleRequest extends BaseRequest {
    @ApiProperty({ description: 'The name of the role' })
    @IsString()
    name!: string;

    @ApiProperty({
        description: 'The description of the role',
        required: false
    })
    @IsString()
    @IsOptional()
    description?: string;

    @ApiProperty({ description: 'External name for the role', required: false })
    @IsString()
    @IsOptional()
    externalName?: string;

    @ApiProperty({ description: 'External ID for the role', required: false })
    @IsString()
    @IsOptional()
    externalId?: string;
}
