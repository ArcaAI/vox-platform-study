import { ArrayMinSize, ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Validate } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isValidServiceAccountScope } from '../service-account-scopes.registry';

/**
 * Every requested scope must be a REGISTRY MEMBER of the `svc:*` namespace.
 *
 * Registry membership is only half the gate — it proves the string is
 * meaningful, never that the caller is entitled to grant it. The privilege
 * CEILING (TASK-756's rule, applied to this class from day one rather than
 * retrofitted) lives in `ServiceAccountService.assertScopeCeiling`.
 */
@ValidatorConstraint({ name: 'ValidServiceAccountScopes', async: false })
export class ValidServiceAccountScopesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.every((scope) => typeof scope === 'string' && isValidServiceAccountScope(scope));
  }

  defaultMessage(): string {
    return 'scopes must all be known svc:* service-account scopes (see SERVICE_ACCOUNT_SCOPE_REGISTRY); admin:* and * belong to tenant API keys and are never valid here';
  }
}

export class CreateServiceAccountRequest {
  @ApiProperty({ description: 'Human-readable name for the machine identity', example: 'Nightly reconciliation bot' })
  @IsString()
  @MaxLength(200)
  displayName!: string;

  @ApiPropertyOptional({ description: 'What this account is for' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: 'The svc:* scopes this account may exercise. Never admin:* — that vocabulary belongs to tenant API keys.',
    example: ['svc:admin:department:manage'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @Validate(ValidServiceAccountScopesConstraint)
  scopes!: string[];

  @ApiPropertyOptional({
    description:
      'The tenant this account is bound to. Omit for a tenant-bound account in the caller working tenant; pass the SYSTEM tenant id for a PLATFORM account.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    description: 'PLATFORM accounts only: the working tenants this account may act on via X-Tenant-Id. Rejected on a tenant-bound account.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  allowedTenantIds?: string[];

  @ApiPropertyOptional({ description: 'Optional source-IP allow-list', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({
    description: 'Grant this machine principal SUPER_ADMIN. Explicit by design — a machine is never elevated by omission or inference.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  superAdmin?: boolean;

  @ApiPropertyOptional({ description: 'Access-token lifetime in seconds (60…3600). Short-lived by design.', default: 900 })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  tokenTtlSeconds?: number;
}
