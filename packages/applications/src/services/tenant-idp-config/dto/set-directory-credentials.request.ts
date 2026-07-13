import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsNotEmptyObject } from 'class-validator';

/**
 * TASK-498 P3/P4 — seals a directory-API credential bundle (shape depends on
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
}
