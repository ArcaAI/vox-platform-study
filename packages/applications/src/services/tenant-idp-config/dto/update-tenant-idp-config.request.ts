import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, MinLength, Min, ValidateNested } from 'class-validator';
import { OidcProviderConfigDto } from './oidc-provider-config.dto';
import { SamlProviderConfigDto } from './saml-provider-config.dto';

/**
 * TASK-498/499 — partial update of an existing provider row. `protocol` is
 * immutable after creation (delete + recreate to change it), so this DTO
 * carries no `protocol` field — the service reads the existing row's
 * protocol to decide whether `config` or `samlConfig` applies (whichever
 * doesn't match the row's protocol is simply ignored if sent). `clientSecret`
 * is write-only and optional — omit to keep the currently-sealed secret; it
 * applies to OIDC providers only. A SAML provider's SP key pair is not
 * rotatable via this endpoint in v1 (delete + recreate to rotate).
 * `expectedVersion` is the OCC token (`If-Match` on the controller).
 */
export class UpdateTenantIdpConfigRequest {
  @ApiPropertyOptional({ description: 'Tenant-admin-facing name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Non-secret OIDC config (full replacement when provided) — OIDC providers only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => OidcProviderConfigDto)
  config?: OidcProviderConfigDto;

  @ApiPropertyOptional({ description: 'Non-secret SAML config (full replacement when provided) — SAML providers only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SamlProviderConfigDto)
  samlConfig?: SamlProviderConfigDto;

  @ApiPropertyOptional({ description: 'Rotate the OIDC client secret — omit to keep the current one' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  clientSecret?: string;

  @ApiProperty({ description: 'OCC token: compare-and-set against the current version (412 on drift)' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
