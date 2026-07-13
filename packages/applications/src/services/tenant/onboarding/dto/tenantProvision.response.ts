import { ApiProperty } from '@nestjs/swagger';
import { TenantResponse } from '../../dto';

/** Response of `ITenantOnboardingService.provisionTenantWithAdmin` (TASK-497 §3.3). */
export class TenantProvisionResponse {
  @ApiProperty({ description: 'The newly provisioned tenant', type: () => TenantResponse })
  tenant!: TenantResponse;

  @ApiProperty({ description: 'Id of the user assigned TENANT_ADMIN in the new tenant' })
  adminUserId!: string;

  @ApiProperty({ description: "The tenant's key (caller-supplied or auto-generated)" })
  tenantKey!: string;

  constructor(init: TenantProvisionResponse) {
    this.tenant = init.tenant;
    this.adminUserId = init.adminUserId;
    this.tenantKey = init.tenantKey;
  }
}
