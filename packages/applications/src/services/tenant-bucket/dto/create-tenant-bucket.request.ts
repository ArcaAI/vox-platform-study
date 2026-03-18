import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTenantBucketRequest {
    @ApiProperty({ description: 'Bucket slug (unique per tenant)', example: 'reports' })
    @IsString()
    @MaxLength(63)
    @Matches(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, {
        message: 'Slug must contain only lowercase letters, numbers, hyphens, and underscores',
    })
    slug: string;

    @ApiPropertyOptional({ description: 'Bucket description' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ description: 'Path pattern for file organization', example: '{yyyy}/{MM}/{dd}/{user_name}' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    pathPattern?: string;
}
