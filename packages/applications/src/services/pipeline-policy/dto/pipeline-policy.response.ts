import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PipelinePolicyScope } from '@arcaai/domains';
import type { ConfigResolutionSource } from '../../config-resolver';

/**
 * Where a policy ROW response was resolved from:
 *  - `tenant` / `department` / `doctor` — an explicit override row at that scope.
 *  - `system-default` — the SYSTEM-tenant platform-default TENANT row.
 *  - `code-default` — no row exists yet; toggles are all null (full inherit) and
 *    `version` is 0 (the ETag interceptor then emits no ETag — correct, as there
 *    is no row to compare-and-set against yet).
 */
export type PipelinePolicySource = 'tenant' | 'department' | 'doctor' | 'system-default' | 'code-default';

/**
 * A single realtime-pipeline policy ROW. Returned by
 * the admin GET/PATCH row routes. The toggle fields are NULLABLE — null means
 * "inherit from the next cascade tier up" (resolution lives in `ConfigResolver`).
 * `version` is the OCC token echoed back via `If-Match: "<version>"` on PATCH.
 */
export class PipelinePolicyResponse {
  @ApiPropertyOptional({ description: 'Policy row id (null when source is `code-default`).', nullable: true })
  id: string | null;

  @ApiProperty({ description: 'Owning tenant id (SYSTEM tenant for the platform default).' })
  tenantId: string;

  @ApiProperty({ description: 'Cascade tier of this row.', enum: PipelinePolicyScope })
  scope: PipelinePolicyScope;

  @ApiPropertyOptional({ description: 'Scope discriminator (departmentId / userId; null for TENANT scope).', nullable: true })
  scopeId: string | null;

  @ApiProperty({ description: 'Where this row was resolved from.' })
  source: PipelinePolicySource;

  @ApiPropertyOptional({ description: 'Auto-summary toggle (null = inherit).', nullable: true })
  autoSummaryEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Auto-NER toggle (null = inherit).', nullable: true })
  autoNerEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Harness-vs-legacy routing toggle (null = inherit). Max scope: department.', nullable: true })
  harnessEnabled: boolean | null;

  @ApiPropertyOptional({
    description: 'Per-doctor DNA writing-style toggle (null = inherit). Doctor-scope storage.',
    nullable: true,
  })
  dnaStyleEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Last update timestamp (ISO-8601; null for code-default).', nullable: true })
  updatedAt: string | null;

  @ApiProperty({ description: 'Row version for optimistic concurrency. Echo as `If-Match: "<version>"` on PATCH.', example: 1 })
  version!: number;
}

/**
 * The RESOLVED effective pipeline config for a consultation context
 * (`tenant [+department] [+doctor]`) — every toggle reduced to a concrete
 * boolean via the cascade, with a per-toggle `trace` reporting the winning tier.
 * Read-only (no `version`); the realtime path consumes the same resolution.
 */
export class PipelinePolicyEffectiveResponse {
  @ApiProperty({ description: 'Tenant the cascade resolved for.' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Department included in the resolution (if any).', nullable: true })
  departmentId: string | null;

  @ApiPropertyOptional({ description: 'Doctor included in the resolution (if any).', nullable: true })
  doctorId: string | null;

  @ApiProperty({ description: 'Resolved auto-summary toggle.' })
  autoSummaryEnabled: boolean;

  @ApiProperty({ description: 'Resolved auto-NER toggle.' })
  autoNerEnabled: boolean;

  @ApiProperty({ description: 'Resolved harness-vs-legacy routing toggle.' })
  harnessEnabled: boolean;

  @ApiProperty({ description: 'Resolved per-doctor DNA writing-style toggle (read-only this phase).' })
  dnaStyleEnabled: boolean;

  @ApiProperty({ description: 'Per-toggle resolution trace (which cascade tier supplied each value).' })
  trace: Record<string, ConfigResolutionSource>;
}
