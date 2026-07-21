import { ApiProperty } from '@nestjs/swagger';

export class ConsumptionConsultations {
  @ApiProperty({ description: 'Total consultations in scope.' })
  total!: number;

  @ApiProperty({ description: 'Consultations created since the start of today (UTC).' })
  today!: number;
}

/**
 * Consumption / usage roll-up. Platform-wide for a
 * super-admin (no scope), or per-tenant when `?tenantId=` is supplied. All
 * figures are Postgres-derived (live-testable); `storageQuotaBytes` is `null`
 * until at least one in-scope bucket sets `TenantBucket.quotaBytes` (#5).
 */
export class ConsumptionRollupResponse {
  @ApiProperty({ description: 'Transcription minutes = SUM(AudioRecording.duration)/60000.' })
  transcriptionMinutes!: number;

  @ApiProperty({ description: 'Summaries generated in the last 24h (SummaryMeta.generatedAt).' })
  summaries24h!: number;

  @ApiProperty({ description: 'Accounted storage bytes = SUM(Media.size).' })
  storageUsedBytes!: number;

  @ApiProperty({ nullable: true, type: Number, description: 'Configured storage quota = SUM(TenantBucket.quotaBytes); null when none set.' })
  storageQuotaBytes!: number | null;

  @ApiProperty({ type: ConsumptionConsultations })
  consultations!: ConsumptionConsultations;

  @ApiProperty({ description: 'When this payload was computed (ISO-8601).' })
  refreshedAt!: string;
}
