import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateUserProfileRequest extends BaseRequest {
    @ApiProperty({ description: 'First name of the user', required: false })
    @IsString()
    @IsOptional()
    firstName?: string;

    @ApiProperty({ description: 'Last name of the user', required: false })
    @IsString()
    @IsOptional()
    lastName?: string;

    @ApiProperty({ description: 'Email address', required: false })
    @IsString()
    @IsOptional()
    email?: string;

    @ApiProperty({ description: 'Phone number', required: false })
    @IsString()
    @IsOptional()
    phone?: string;

    @ApiProperty({ description: 'Avatar media ID', required: false })
    @IsString()
    @IsOptional()
    avatarId?: string;

    @ApiProperty({ description: 'ID of the associated user', required: false })
    @IsString()
    @IsOptional()
    userId?: string;
}
