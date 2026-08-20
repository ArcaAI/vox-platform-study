import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsNotEmptyObject, IsOptional, Min } from 'class-validator';

/**
 * Seals a directory-API credential bundle (shape depends on
 * `config.directoryProvider`: `{azureTenantId,clientId,clientSecret}` for
 * ms-graph, `{serviceAccountEmail,privateKey,delegatedAdminEmail,customerId?}`
 * for google-directory) into `TenantIdentityProvider.directoryCredentialsRef`
 * via Vault Transit. Write-only — never echoed back.
 */
export class SetDirectoryCredentialsRequest {
  @ApiProperty({ description: 'Directory-provider-specific credential bundle (JSON-stringified, then Vault-sealed)' })
  @IsObject()
  @IsNotEmptyObject()
  credentials!: Record<string, unknown>;

  /**
   * OCC token. The route carries `@RequiresIfMatch()`, so a browser client
   * supplies the version through the `If-Match` header (which overrides this
   * field). Kept on the DTO for the documented service-to-service fallback,
   * exactly as `UpdateTenantIdpConfigRequest` does.
   */
  @ApiPropertyOptional({ description: 'Row version the client read (OCC). The `If-Match` header overrides it.', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
