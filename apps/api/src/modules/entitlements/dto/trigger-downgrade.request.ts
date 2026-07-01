import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TenantPlan } from '@arcaai/domains';

/**
 * TASK-392 (Q10) — explicitly downgrade a tenant's plan. The plan change always
 * applies; the newest-first soft-disable of overflow resources runs only when
 * the enforcement kill-switch is ON (a reversible `DISABLED` flip, never a
 * delete). SUPER_ADMIN-only at the route.
 */
export class TriggerDowngradeRequest {
  @ApiProperty({ enum: TenantPlan, description: 'The plan to downgrade the tenant to (e.g. STARTER).' })
  @IsEnum(TenantPlan)
  plan: TenantPlan;
}
