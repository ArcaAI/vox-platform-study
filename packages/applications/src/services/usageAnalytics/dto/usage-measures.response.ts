import { ApiProperty } from '@nestjs/swagger';

/**
 * The compute, network and storage figures that ride BESIDE the per-model
 * breakdown on the usage surfaces (TASK-959 §10.2).
 *
 * ============================================================================
 * WHY THESE ARE THEIR OWN FIGURES AND NOT MORE `lines[]` ENTRIES
 * ============================================================================
 * Every one of them IS in `lines[]` — a `GPU_SECOND` row appears there like any
 * other (capability × provider × model × unit) slice. What `lines[]` cannot do
 * is answer the question the figure exists for without the reader knowing the
 * ledger's internal rules: that `cuda`/`mps` occupancy is a different unit from
 * `cpu` occupancy, that the durable worker's CPU is under its own capability and
 * must NOT be added to the inference total, and that a byte row's `deployment`
 * is what decides whether it crossed to a vendor at all. Pre-computing them
 * here puts that knowledge in one place instead of in every consumer.
 *
 * QUANTITIES ARE FIXED-POINT STRINGS, six decimal places, matching
 * `UsageSummaryLine.quantity`. The ledger columns are `Decimal(24,6)`/(38,6);
 * a JSON number is an IEEE double, and at terabyte-second scale it stops
 * representing those exactly.
 */
export class UsageComputeSeconds {
  @ApiProperty({ description: 'Σ GPU_SECOND across the inference capabilities (device cuda or mps). Fixed-point, 6 dp.' })
  gpuSeconds!: string;

  @ApiProperty({
    description:
      'Σ CPU_SECOND across the inference capabilities. EXCLUDES the durable worker (capability WORKFLOW) — that is reported separately as workflowCpuSeconds. Fixed-point, 6 dp.',
  })
  cpuSeconds!: string;
}

/**
 * Bytes that crossed to a THIRD PARTY — `deployment` CLOUD or BYOK only.
 *
 * Self-hosted byte rows are recorded too (the platform's own pool transport
 * sees LM Studio traffic for free), but LAN traffic to a server the platform
 * runs is not third-party consumption and would swamp the figure it belongs to.
 */
export class UsageThirdPartyBytes {
  @ApiProperty({ description: 'Σ EGRESS_BYTE on CLOUD/BYOK rows. Fixed-point, 6 dp.' })
  egressBytes!: string;

  @ApiProperty({ description: 'Σ INGRESS_BYTE on CLOUD/BYOK rows. Fixed-point, 6 dp.' })
  ingressBytes!: string;
}

/**
 * What the tenant was HOLDING at the most recent nightly snapshot in the
 * period — a level, not a period sum.
 *
 * Summing `STORAGE_GB_DAY` over a month answers "GB-days consumed" (which is
 * what the invoice rates); this answers "how much is stored", which is the
 * figure a quota and a capacity question need. `null` on the response means no
 * snapshot exists for the period at all — deliberately distinct from a zeroed
 * object, because "nobody measured" is a reason to look at the job and "the
 * tenant stores nothing" is not.
 */
export class UsageStorageSnapshotSummary {
  @ApiProperty({ description: 'Per-tenant MinIO objects (Media.size). Fixed-point GB, 6 dp.' })
  mediaGb!: string;

  @ApiProperty({ description: 'Encrypted Postgres columns (pg_column_size of the stored bytes). Fixed-point GB, 6 dp.' })
  textGb!: string;

  @ApiProperty({ description: 'Offloaded harness claim-check payloads. Fixed-point GB, 6 dp.' })
  claimCheckGb!: string;

  @ApiProperty({ description: 'Σ of the three classes. Fixed-point GB, 6 dp.' })
  totalGb!: string;

  @ApiProperty({ description: 'When the snapshot was taken (the end of the UTC day it measured), ISO-8601.' })
  asOf!: string;
}
