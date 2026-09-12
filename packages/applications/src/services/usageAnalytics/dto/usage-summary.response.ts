import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { UsageComputeSeconds, UsageStorageSnapshotSummary, UsageThirdPartyBytes } from './usage-measures.response';

/**
 * One (capability × provider × model × unit) rollup slice, summed over the
 * requested period.
 *
 * Money as integer-micros STRINGS (convention — a JSON number is an IEEE
 * double and these values are already rated in the ledger).
 */
export class UsageSummaryLine {
  @ApiProperty()
  capability!: string;

  @ApiProperty()
  provider!: string;

  @ApiPropertyOptional({ description: 'Empty string sentinel when the capability selects no model.' })
  model!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty({ description: 'Summed quantity in the unit above.' })
  quantity!: string;

  @ApiProperty({ description: 'Summed INTERNAL-basis rated cost, integer micros. Excludes BYOK_NOTIONAL (see byokNotionalCostMicros).' })
  costMicros!: string;
}

export class UsageSummaryResponse {
  @ApiProperty({ description: 'Billing-period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ type: UsageSummaryLine, isArray: true })
  lines!: UsageSummaryLine[];

  @ApiProperty({ description: 'Σ costMicros across every line (INTERNAL basis only).' })
  totalCostMicros!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'BYOK notional spend by capability, integer micros. A product-visibility figure — never billed (D14).',
  })
  byokNotionalCostMicrosByCapability!: Record<string, string>;

  // ── TASK-959: compute, network and storage ────────────────────────────────
  // Derived from the SAME daily rollups as `lines` above — no extra query — and
  // additive: every field that existed before this ticket is unchanged.

  @ApiProperty({ type: UsageComputeSeconds, description: 'GPU vs CPU occupancy seconds across the inference capabilities.' })
  computeSeconds!: UsageComputeSeconds;

  @ApiProperty({
    description:
      "Σ CPU_SECOND under capability WORKFLOW — the durable worker's own CPU for this tenant's runs. Its own figure because a run's worker CPU is neither STT nor LLM, and adding it to computeSeconds would double-count it against a compute allowance. Fixed-point, 6 dp.",
  })
  workflowCpuSeconds!: string;

  @ApiProperty({
    type: UsageThirdPartyBytes,
    description: 'Bytes that crossed to a vendor (deployment CLOUD or BYOK). Self-hosted traffic excluded.',
  })
  thirdPartyBytes!: UsageThirdPartyBytes;

  @ApiProperty({
    type: UsageStorageSnapshotSummary,
    nullable: true,
    description:
      'What the tenant was HOLDING at the latest nightly snapshot within the period, split by class — a level, not the period\u2019s GB-day sum. Null when no snapshot exists for the period, which is deliberately distinct from a zeroed object.',
  })
  storage!: UsageStorageSnapshotSummary | null;
}
