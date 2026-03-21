import { IsString, IsOptional, IsArray, MaxLength, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStorageAccessKeyRequest {
    @ApiProperty({ description: 'Key name', example: 'Production Read Key' })
    @IsString()
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({ description: 'Key description' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({ description: 'Permissions', example: ['read', 'write'] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    permissions?: string[];

    @ApiPropertyOptional({ description: 'Bucket IDs to scope access (empty = all tenant buckets)' })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    bucketIds?: string[];

    @ApiPropertyOptional({ description: 'Key expiration date (ISO 8601)' })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}
