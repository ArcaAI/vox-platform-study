import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiModelAvailability } from '@arcaai/domains';

/** One catalogue row's measured verdict from an inventory run. */
export class ModelInventoryRow {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty({ enum: AiModelAvailability }) availability: AiModelAvailability;
  @ApiPropertyOptional({ description: 'Per-object verification detail (missing objects, digest drift, reason).' })
  detail: Record<string, unknown>;
}

/**
 * A prefix in the bucket that no catalogue row references — a candidate for
 * "Register".
 *
 * `flat` / `hf-cache` carry a `manifest.json` the publisher wrote. `staged`
 * (TASK-960) does NOT: it is an admin upload, discovered by the weight files
 * under it, and it is the only layout whose `version` may be absent.
 */
export class UnregisteredBucketPrefix {
  @ApiProperty({ example: 'orphan-model/q4-0-123456789abc/' }) bucketPrefix: string;
  @ApiProperty({ enum: ['flat', 'hf-cache', 'staged'] }) layout: 'flat' | 'hf-cache' | 'staged';
  @ApiPropertyOptional({ nullable: true }) slug: string | null;
  @ApiPropertyOptional({ nullable: true }) version: string | null;
  @ApiProperty() objectCount: number;
  @ApiPropertyOptional({ nullable: true }) totalBytes: number | null;
}

export class ModelInventoryCounts {
  @ApiProperty() available: number;
  @ApiProperty() missing: number;
  @ApiProperty() partial: number;
  @ApiProperty() notApplicable: number;
}

/** `POST admin/ai-models/inventory` response — the result of one run. */
export class ModelInventoryReport {
  @ApiProperty() checkedAt: Date;
  @ApiProperty({ type: ModelInventoryCounts }) counts: ModelInventoryCounts;
  @ApiProperty({ type: [ModelInventoryRow] }) rows: ModelInventoryRow[];
  @ApiProperty({ type: [UnregisteredBucketPrefix], description: '"In bucket, not registered" — candidates for Register.' })
  unregistered: UnregisteredBucketPrefix[];
}
