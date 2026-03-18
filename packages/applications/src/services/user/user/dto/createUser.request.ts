import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsDate } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserRequest extends BaseRequest {
    @ApiProperty({ description: 'Username of the user' })
    @IsString()
    username!: string;

    @ApiProperty({ description: 'Password for the user' })
    @IsString()
    password!: string;

    @ApiProperty({ description: 'External identifier', required: false })
    @IsString()
    @IsOptional()
    externalId?: string;

    @ApiProperty({ description: 'Whether this is a service account', required: false, default: false })
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
