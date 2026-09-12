import { ApiProperty } from '@nestjs/swagger';

import { UsageComputeSeconds, UsageThirdPartyBytes } from './usage-measures.response';

export class UsageTimeseriesPoint {
  @ApiProperty({ description: 'UTC bucket start, ISO-8601.' })
  bucketStart!: string;

  @ApiProperty({ description: 'Summed quantity in `unit`, across every provider/model.' })
  quantity!: string;

  @ApiProperty({ description: 'Summed INTERNAL-basis rated cost, integer micros.' })
  costMicros!: string;

  // ── TASK-959: the companion figures, per bucket ───────────────────────────
  // `quantity`/`costMicros` above are the SELECTED (capability, unit) series.
  // These four are the same bucket's compute, network and storage totals across
  // EVERY capability and unit, so one request draws the selected series against
  // the platform cost that moved with it. They are read from the same buckets
  // the series is filtered out of — no extra query.

  @ApiProperty({ type: UsageComputeSeconds, description: 'GPU vs CPU occupancy seconds in this bucket, inference capabilities only.' })
  computeSeconds!: UsageComputeSeconds;

  @ApiProperty({ description: "Σ CPU_SECOND under capability WORKFLOW in this bucket — the durable worker's own CPU. Fixed-point, 6 dp." })
  workflowCpuSeconds!: string;

  @ApiProperty({ type: UsageThirdPartyBytes, description: 'Bytes to a vendor in this bucket (CLOUD/BYOK only).' })
  thirdPartyBytes!: UsageThirdPartyBytes;

  @ApiProperty({
    nullable: true,
    description:
      'Σ STORAGE_GB_DAY in this bucket across every class — the rollup grain cannot split media from claim-check (both are provider `minio`), so this is the total; the per-class split is on the summary. Null when the bucket carries no snapshot at all, which for hourly granularity is every hour but the one the job ran in.',
  })
  storageGb!: string | null;
}

export class UsageTimeseriesResponse {
  @ApiProperty()
  capability!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty({ enum: ['day', 'hour'] })
  granularity!: 'day' | 'hour';

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: UsageTimeseriesPoint, isArray: true })
  points!: UsageTimeseriesPoint[];
}
