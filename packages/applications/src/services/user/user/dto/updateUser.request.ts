import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsDate, IsIn } from 'class-validator';
import { ResourceStatusType } from '@arcaai/domains';
import { BaseRequest } from '../../../../common';

export class UpdateUserRequest extends BaseRequest {
    @ApiProperty({ description: 'Username of the user', required: false })
    @IsString()
    @IsOptional()
    username?: string;

    @ApiProperty({
        description: 'Resource status (ENABLED or DISABLED)',
        enum: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED],
        required: false,
    })
    @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
    @IsOptional()
    resourceStatus?: ResourceStatusType;

    @ApiProperty({ description: 'Password for the user', required: false })
    @IsString()
    @IsOptional()
    password?: string;

    @ApiProperty({ description: 'External identifier', required: false })
    @IsString()
    @IsOptional()
    externalId?: string;

    @ApiProperty({
        description: 'Whether this is a service account',
        required: false
    })
    @IsBoolean()
    @IsOptional()
    isServiceAccount?: boolean;

    @ApiProperty({ description: 'First secret key', required: false })
    @IsString()
    @IsOptional()
    secret1?: string;

    @ApiProperty({ description: 'First secret key expiry', required: false })
    @IsDate()
    @IsOptional()
    secret1Expiry?: Date;

    @ApiProperty({ description: 'Second secret key', required: false })
    @IsString()
    @IsOptional()
    secret2?: string;

    @ApiProperty({ description: 'Second secret key expiry', required: false })
    @IsDate()
    @IsOptional()
    secret2Expiry?: Date;
}
