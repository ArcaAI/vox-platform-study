import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/** Body for `PATCH /admin/schedulers/:name/cron`. Only dynamic schedulers are editable. */
export class UpdateSchedulerCronRequest {
  @ApiProperty({ example: '0 2 * * *', description: 'New 5/6-field cron expression. Validated server-side.' })
  @IsString()
  @IsNotEmpty()
  cronExpression!: string;
}

/** Body for `PATCH /admin/schedulers/:name/toggle`. */
export class ToggleSchedulerRequest {
  @ApiProperty({ description: 'Enable (true) or disable (false) the dynamic scheduler.' })
  @IsBoolean()
  enabled!: boolean;
}

// ---------------------------------------------------------------------------
// Response DTOs (Swagger documentation only — the service returns the matching
// `SchedulerInfo` plain object)
// ---------------------------------------------------------------------------

export class SchedulerInfoResponse {
  @ApiProperty({ example: 'dna-regeneration' }) name!: string;
  @ApiProperty({ enum: ['cron', 'interval', 'timeout'] }) type!: string;
  @ApiProperty({ enum: ['static', 'dynamic'], description: 'Only `dynamic` schedulers can be edited/toggled.' }) source!: string;
  @ApiProperty({ nullable: true, type: String }) cronExpression!: string | null;
  @ApiProperty({ nullable: true, type: Number }) intervalMs!: number | null;
  @ApiProperty() running!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'ISO datetime of the last run.' }) lastExecution!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ISO datetime of the next run.' }) nextExecution!: string | null;
  @ApiProperty({ nullable: true, type: String }) timeZone!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Backing GlobalSetting key if dynamic.' }) settingsKey!: string | null;
}
