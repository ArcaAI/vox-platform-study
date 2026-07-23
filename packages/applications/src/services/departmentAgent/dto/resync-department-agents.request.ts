import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Trigger the SYSTEM agent-library resync (TASK-548).
 *
 * `tenantId` is OPTIONAL: when supplied, only that tenant is reconciled; when
 * omitted, every non-SYSTEM tenant is swept (the same all-tenant reconcile the
 * nightly cron runs). No other field is accepted — the gateway's
 * `whitelist + forbidNonWhitelisted` pipe rejects anything else.
 */
export class ResyncDepartmentAgentsRequest {
  @ApiPropertyOptional({
    description: 'Reconcile only this tenant; omit to sweep every non-SYSTEM tenant.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
