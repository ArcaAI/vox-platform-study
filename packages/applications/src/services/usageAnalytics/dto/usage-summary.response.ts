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

/**
 * One OPERATION's usage over the period (TASK-957 F-8).
 *
 * `operation` IS a rollup dimension (`AiUsageRollupDaily.operation`), so this is
 * a regroup of the rollups `lines` is already built from — the same read, asked
 * a different question, and it carries rated cost for exactly that reason.
 *
 * Quantity is per UNIT rather than a single number because an operation spans
 * units that cannot be added: `generate` produces INPUT_TOKEN, OUTPUT_TOKEN and
 * CPU_SECOND rows, and one figure over those three would be arithmetic on
 * incompatible things.
 */
export class UsageSummaryOperationLine {
  @ApiProperty({ description: 'One of the frozen operations (usageLedger/vocabulary.ts).' })
  operation!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Unit -> summed quantity over the period, fixed-point 6 dp. Units are not summable with each other.',
  })
  quantityByUnit!: Record<string, string>;

  @ApiProperty({ description: 'Summed INTERNAL-basis rated cost across every unit of this operation, integer micros.' })
  costMicros!: string;
}

/**
 * One TRIGGER's usage over the period — WHICH PRODUCT ACTIVITY caused the
 * inference (TASK-957 F-8, OD-E's closed vocabulary).
 *
 * NO COST, deliberately. `trigger` is an ATTRIBUTE (`attributesJson.trigger`),
 * not a rollup dimension, so this is the one figure on this response that comes
 * from the RAW ledger rather than the daily rollups — and summing rated cost
 * outside the rollups is precisely what D13 says not to do. Quantity is the
 * honest answer the raw rows can give.
 *
 * The read is bounded because the vocabulary is closed: one server-side
 * aggregate per trigger value, each scoped to `(tenantId, period)`. Same
 * escape hatch, and the same structural justification, as
 * `MeteringService.countGuardrailCalls`.
 */
export class UsageSummaryTriggerLine {
  @ApiProperty({ description: "One of OD-E's five triggers (usageLedger/usage-attributes.ts)." })
  trigger!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Unit -> summed quantity over the period, fixed-point 6 dp.',
  })
  quantityByUnit!: Record<string, string>;
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

  // ── TASK-957 F-8: what KIND of work, and what CAUSED it ───────────────────
  // Both additive. `lines`, `totalCostMicros` and every TASK-959 measure are
  // unchanged — a consumption screen reading them must not notice this ticket.

  @ApiProperty({
    type: UsageSummaryOperationLine,
    isArray: true,
    description: 'Usage grouped by operation, from the same daily rollups as `lines`. Sorted by operation.',
  })
  byOperation!: UsageSummaryOperationLine[];

  @ApiProperty({
    type: UsageSummaryTriggerLine,
    isArray: true,
    description:
      'Usage grouped by the activity that CAUSED it. From the raw ledger, not the rollups — `trigger` is an attribute, not a rollup dimension — so it carries quantity and no cost. A trigger with no usage is omitted rather than zeroed.',
  })
  byTrigger!: UsageSummaryTriggerLine[];

  @ApiProperty({
    type: UsageStorageSnapshotSummary,
    nullable: true,
    description:
      'What the tenant was HOLDING at the latest nightly snapshot within the period, split by class — a level, not the period\u2019s GB-day sum. Null when no snapshot exists for the period, which is deliberately distinct from a zeroed object.',
  })
  storage!: UsageStorageSnapshotSummary | null;
}
