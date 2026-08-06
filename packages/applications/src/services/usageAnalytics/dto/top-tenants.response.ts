import { ApiProperty } from '@nestjs/swagger';

export class TopTenantUsage {
  @ApiProperty()
  tenantId!: string;

  @ApiProperty({ description: 'Σ rollup cost (INTERNAL basis only), integer micros.' })
  costMicros!: string;
}

/** GLOBAL-ADMIN-only cross-tenant rollup query (TASK-615 WS-J). */
export class TopTenantsResponse {
  @ApiProperty({ description: 'Billing-period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ enum: ['cost'] })
  metric!: 'cost';

  @ApiProperty({ type: TopTenantUsage, isArray: true })
  tenants!: TopTenantUsage[];
}
