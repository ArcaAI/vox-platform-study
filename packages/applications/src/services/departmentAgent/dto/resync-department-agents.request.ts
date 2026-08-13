import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Trigger the SYSTEM agent-library resync.
 *
 * `tenantId` is OPTIONAL: when supplied, only that tenant is reconciled; when
 * omitted, every non-SYSTEM tenant is swept (the same all-tenant reconcile the
 * nightly cron runs). No other field is accepted — the gateway's
 * `whitelist + forbidNonWhitelisted` pipe rejects anything else.
 *
 * Validated as a plain string, NOT `@IsUUID()`: the reserved platform tenant
 * ids (`00000000-…`, `50000000-…`) are deliberately NOT RFC-4122-versioned
 * UUIDs, so `@IsUUID()` would reject the very seed tenants (Global, ArcaAI) this
 * endpoint must reconcile. This mirrors the pipeline resync sibling, whose
 * `:id` path param is an unvalidated string; the service rejects the SYSTEM
 * tenant explicitly.
 */
export class ResyncDepartmentAgentsRequest {
  @ApiPropertyOptional({
    description: 'Reconcile only this tenant; omit to sweep every non-SYSTEM tenant.',
  })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
