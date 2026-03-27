import { ApiProperty } from '@nestjs/swagger';
import { ApiKeyStatus, ApiKeyType } from '@arcaai/domains';
import { BaseResponse, BaseResponseProps } from '../../../common';

export interface ApiKeyResponseProps extends BaseResponseProps {
  keyName: string;
  keyPrefix: string;
  keyType: ApiKeyType;
  keyStatus: ApiKeyStatus;
  scopes?: string[] | null;
  allowedIps?: string[] | null;
  rateLimit?: number | null;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  usageCount: number;
  description?: string | null;
  environment?: string | null;
  userId?: string | null;
  tenantId?: string | null;
}

export class ApiKeyResponse extends BaseResponse {
  @ApiProperty({ description: 'Human readable name for the API key' })
  readonly keyName: string;

  @ApiProperty({ description: 'First 12 characters of the key for identification' })
  readonly keyPrefix: string;

  @ApiProperty({ enum: ApiKeyType, description: 'Type of API key' })
  readonly keyType: ApiKeyType;

  @ApiProperty({ enum: ApiKeyStatus, description: 'Current status of the API key' })
  readonly keyStatus: ApiKeyStatus;

  @ApiProperty({ description: 'Array of permissions/scopes', required: false, type: [String] })
  readonly scopes?: string[] | null;

  @ApiProperty({ description: 'Array of allowed IP addresses', required: false, type: [String] })
  readonly allowedIps?: string[] | null;

  @ApiProperty({ description: 'Requests per minute limit', required: false })
  readonly rateLimit?: number | null;

  @ApiProperty({ description: 'Expiration date', required: false })
  readonly expiresAt?: Date | null;

  @ApiProperty({ description: 'Last time the key was used', required: false })
  readonly lastUsedAt?: Date | null;

  @ApiProperty({ description: 'Total number of uses' })
  readonly usageCount: number;

  @ApiProperty({ description: 'Description of the key purpose', required: false })
  readonly description?: string | null;

  @ApiProperty({ description: 'Environment (dev, staging, production)', required: false })
  readonly environment?: string | null;

  @ApiProperty({ description: 'User ID who owns this key', required: false })
  readonly userId?: string | null;

  @ApiProperty({ description: 'Tenant ID', required: false })
  readonly tenantId?: string | null;

  constructor(props: ApiKeyResponseProps) {
    super(props);
    this.keyName = props.keyName;
    this.keyPrefix = props.keyPrefix;
    this.keyType = props.keyType;
    this.keyStatus = props.keyStatus;
    this.scopes = props.scopes;
    this.allowedIps = props.allowedIps;
    this.rateLimit = props.rateLimit;
    this.expiresAt = props.expiresAt;
    this.lastUsedAt = props.lastUsedAt;
    this.usageCount = props.usageCount;
    this.description = props.description;
    this.environment = props.environment;
    this.userId = props.userId;
    this.tenantId = props.tenantId;
  }
}
