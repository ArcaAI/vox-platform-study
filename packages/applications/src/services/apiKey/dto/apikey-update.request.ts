import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, IsInt, IsDateString, MaxLength, Min, ArrayMinSize, Validate } from 'class-validator';
import { ValidScopesConstraint } from '../validators/valid-scopes.validator';
import { ApiKeyStatus } from '@arcaai/domains';
import { BaseRequest } from '../../../common';

export class UpdateApiKeyRequest extends BaseRequest {
  @ApiProperty({ description: 'Human readable name for the API key', required: false })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  keyName?: string;

  @ApiProperty({ enum: ApiKeyStatus, description: 'Status of the API key', required: false })
  @IsEnum(ApiKeyStatus)
  @IsOptional()
  keyStatus?: ApiKeyStatus;

  @ApiProperty({ description: 'Array of permissions/scopes', required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one scope is required when updating scopes' })
  @Validate(ValidScopesConstraint)
  @IsOptional()
  scopes?: string[];

  @ApiProperty({ description: 'Array of allowed IP addresses', required: false, type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedIps?: string[];

  @ApiProperty({ description: 'Requests per minute limit', required: false })
  @IsInt()
  @Min(0)
  @IsOptional()
  rateLimit?: number;

  @ApiProperty({ description: 'Expiration date (ISO 8601)', required: false })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @ApiProperty({ description: 'Description of the key purpose', required: false })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Environment (dev, staging, production)', required: false })
  @IsString()
  @MaxLength(50)
  @IsOptional()
  environment?: string;
}
