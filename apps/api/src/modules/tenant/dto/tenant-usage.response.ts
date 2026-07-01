import { ApiProperty } from '@nestjs/swagger';

export class TenantUsageResponse {
  @ApiProperty({ description: 'Total number of users in the tenant' })
  totalUsers!: number;

  @ApiProperty({ description: 'Total number of departments' })
  totalDepartments!: number;

  @ApiProperty({ description: 'Total number of prompt templates' })
  totalPromptTemplates!: number;

  @ApiProperty({ description: 'Total number of pipelines' })
  totalPipelines!: number;

  // TASK-386 (#5 / E5) — storage roll-ups for the Tenant Detail "Storage" tile.
  @ApiProperty({ description: 'Storage used in bytes (SUM of Media.size).' })
  storageUsedBytes!: number;

  @ApiProperty({
    description: 'Configured storage quota in bytes (SUM of TenantBucket.quotaBytes); null when no bucket has a quota set.',
    nullable: true,
    type: Number,
  })
  storageQuotaBytes!: number | null;

  // TASK-386 (#16 / E5) — clinical roll-ups for the Tenant Detail "Overview" tile.
  @ApiProperty({ description: 'Transcription minutes (SUM of AudioRecording.duration ms / 60000).' })
  transcriptionMinutes!: number;

  @ApiProperty({ description: 'Summaries generated in the last 24h.' })
  summaries24h!: number;

  @ApiProperty({ description: 'Total consultations in the tenant.' })
  totalConsultations!: number;
}
