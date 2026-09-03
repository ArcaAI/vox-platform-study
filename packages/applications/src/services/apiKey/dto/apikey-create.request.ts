import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, IsInt, IsDateString, MaxLength, Min, ArrayMinSize, Validate } from 'class-validator';
import { NoReservedScopesConstraint, ValidScopesConstraint } from '../validators/valid-scopes.validator';
import { ApiKeyType } from '@arcaai/domains';
import { BaseRequest } from '../../../common';

export class CreateApiKeyRequest extends BaseRequest {
  @ApiProperty({ description: 'Human readable name for the API key' })
  @IsString()
  @MaxLength(255)
  keyName: string;

  @ApiProperty({ enum: ApiKeyType, description: 'Type of API key', default: ApiKeyType.SDK })
  @IsEnum(ApiKeyType)
  @IsOptional()
  keyType?: ApiKeyType;

  @ApiProperty({ description: 'Array of permissions/scopes (at least one required)', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one scope is required' })
  @Validate(ValidScopesConstraint)
  // (policy A2) — reserved (`admin:*`, `webhook:*`) scopes cannot be
  // granted. CREATE only: every scope here is new, so a membership-style
  // constraint is correct. The UPDATE equivalent is a widening-DELTA check in
  // `ApiKeyService.update()`, because a constraint cannot see the stored key.
  @Validate(NoReservedScopesConstraint)
  scopes: string[];

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
