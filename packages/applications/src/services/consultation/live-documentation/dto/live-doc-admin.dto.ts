import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Per-session live-documentation engine stats.
 *
 * The PHI-safe snapshot the {@link LiveDocumentationService} publishes to Redis
 * (`live-doc:stats:{consultationId}`) on each flush and the admin live console
 * reads back. Sizes / latencies / counts only — never transcript or summary text.
 */
export class LiveDocSessionStatsResponse {
  @ApiProperty({ description: 'Consultation under live documentation' })
  consultationId: string;

  @ApiProperty({ description: 'Owning tenant id' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'STT streaming session id bound to this recording' })
  sessionId?: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of when the watcher session started' })
  startedAt: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the last published flush' })
  lastUpdatedAt: string;

  @ApiProperty({ description: 'Number of flushes published so far' })
  flushCount: number;

  @ApiProperty({ description: 'Monotonic flush generation id of the last flush' })
  generation: number;

  @ApiProperty({ description: 'SMR running-summary latency of the last flush (ms)' })
  textLatencyMs: number;

  @ApiProperty({ description: 'NLP entity-extraction latency of the last flush (ms)' })
  nlpLatencyMs: number;

  @ApiProperty({ description: 'Whether the last SMR call failed (prior summary retained)' })
  textFailed: boolean;

  @ApiProperty({ description: 'Whether the last NLP call failed (prior entities retained)' })
  nlpFailed: boolean;

  @ApiProperty({ description: 'Count of superseded (stale) generations dropped without publishing' })
  staleDropCount: number;

  @ApiProperty({ description: 'Number of medical entities in the last published summary' })
  entityCount: number;

  @ApiProperty({ description: 'Number of summary sections in the last published summary' })
  sectionCount: number;

  @ApiProperty({ description: 'Character length of the last running summary (size only, no text)' })
  summaryChars: number;
}

/** A tenant's active live-documentation sessions (`GET /admin/harness/live/sessions`). */
export class LiveDocSessionsListResponse {
  @ApiProperty({ description: 'Active recording sessions with their live stats', type: [LiveDocSessionStatsResponse] })
  items: LiveDocSessionStatsResponse[];

  @ApiProperty({ description: 'Number of active sessions' })
  total: number;
}

/** Where the effective live-engine enabled flag was resolved from. */
export type LiveDocEngineConfigSource = 'env-default' | 'redis-override';

/** The effective live-documentation engine config / kill-switch (`GET /admin/harness/live/config`). */
export class LiveDocEngineConfigResponse {
  @ApiProperty({ description: 'Effective enabled state (Redis override if set, else env default)' })
  enabled: boolean;

  @ApiProperty({ description: 'The `LIVE_DOC_ENABLED` env default baked in at boot' })
  envDefault: boolean;

  @ApiProperty({
    description: 'Whether the effective value comes from the env default or a runtime Redis override',
    enum: ['env-default', 'redis-override'],
  })
  source: LiveDocEngineConfigSource;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp of the last runtime override' })
  updatedAt?: string;

  @ApiPropertyOptional({ description: 'User id that last toggled the runtime override' })
  updatedBy?: string;

  // the effective agentic.context.* knobs the live loop
  // reads (settings-registry namespace; env override → registry code default).
  @ApiPropertyOptional({
    description: 'Effective agentic.context.* knobs the live-documentation loop reads.',
    type: 'object',
    additionalProperties: true,
  })
  contextSettings?: Record<string, unknown>;
}

/** Body for `PATCH /admin/harness/live/config` — toggle the kill-switch. */
export class UpdateLiveDocEngineConfigRequest {
  @ApiProperty({ description: 'Desired engine enabled state (false = kill-switch engaged)' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ description: 'Optional audit reason for the toggle' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
