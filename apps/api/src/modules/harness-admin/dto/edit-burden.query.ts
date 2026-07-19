import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Query for `GET /admin/harness/edit-burden` (TASK-508 Phase 0 defect D3).
 * Delegates to `HarnessObservabilityService#getEditBurden(tenantId, consultationId)` —
 * a single-consultation lookup, so `consultationId` is required. `tenantId` is
 * the same platform-admin cross-tenant override used by every other read on
 * `HarnessAdminController`.
 */
export class EditBurdenQuery {
  @ApiProperty({ description: 'Consultation to derive edit-burden telemetry for.' })
  @IsString()
  @MinLength(1)
  consultationId: string;

  @ApiPropertyOptional({ description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
