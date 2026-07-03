import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

const JOB_STATUSES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;
const CLEANABLE_STATUSES = ['completed', 'failed'] as const;
const BULK_ACTIONS = ['retry', 'remove'] as const;

/** Query params for `GET /admin/queues/:queueName/jobs`. */
export class ListJobsQuery {
  @ApiProperty({ required: false, minimum: 0, default: 0, description: 'Zero-based page index.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20, description: 'Page size.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ required: false, enum: JOB_STATUSES, description: 'Filter by BullMQ job status (omit for all).' })
  @IsOptional()
  @IsIn(JOB_STATUSES as unknown as string[])
  status?: string;

  @ApiProperty({ required: false, description: 'Filter by job name.' })
  @IsOptional()
  @IsString()
  jobName?: string;
}

/** Body for `POST /admin/queues/:queueName/clean`. Only completed/failed jobs are cleanable. */
export class CleanQueueRequest {
  @ApiProperty({ enum: CLEANABLE_STATUSES, description: 'Which finished jobs to clean.' })
  @IsIn(CLEANABLE_STATUSES as unknown as string[])
  status!: (typeof CLEANABLE_STATUSES)[number];

  @ApiProperty({ minimum: 0, description: 'Only clean jobs finished more than this many milliseconds ago.' })
  @IsInt()
  @Min(0)
  gracePeriodMs!: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 10000, default: 1000, description: 'Max jobs to clean.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}

/** Body for `POST /admin/queues/:queueName/jobs/bulk`. */
export class BulkJobActionRequest {
  @ApiProperty({ enum: BULK_ACTIONS, description: 'Action to apply to every supplied job id.' })
  @IsIn(BULK_ACTIONS as unknown as string[])
  action!: (typeof BULK_ACTIONS)[number];

  @ApiProperty({ type: [String], minItems: 1, maxItems: 100, description: 'Job ids to act on.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  jobIds!: string[];
}

// ---------------------------------------------------------------------------
// Response DTOs (Swagger documentation only — the services return the matching
// `@arcaai/domains` plain objects)
// ---------------------------------------------------------------------------

export class QueueJobCountsResponse {
  @ApiProperty() waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() delayed!: number;
  @ApiProperty() paused!: number;
  @ApiProperty() prioritized!: number;
}

export class QueueStatsResponse {
  @ApiProperty({ example: 'SendEmail' }) name!: string;
  @ApiProperty() isPaused!: boolean;
  @ApiProperty({ type: QueueJobCountsResponse }) counts!: QueueJobCountsResponse;
  @ApiProperty({ description: 'Number of attached workers.' }) workerCount!: number;
}

export class JobSummaryResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() queueName!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: Number }) progress!: number | null;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty() delay!: number;
  @ApiProperty() timestamp!: number;
  @ApiProperty({ nullable: true, type: Number }) processedOn!: number | null;
  @ApiProperty({ nullable: true, type: Number }) finishedOn!: number | null;
  @ApiProperty({ nullable: true, type: String }) failedReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) parentId!: string | null;
}

export class JobOptionsResponse {
  @ApiProperty() attempts!: number;
  @ApiProperty() delay!: number;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true, description: 'Backoff config or null.' })
  backoff!: { type: string; delay: number } | null;
  @ApiProperty() priority!: number;
  @ApiProperty({ description: 'boolean | number' }) removeOnComplete!: boolean | number;
  @ApiProperty({ description: 'boolean | number' }) removeOnFail!: boolean | number;
}

export class JobDetailResponse extends JobSummaryResponse {
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'PII-redacted job payload.' })
  data!: Record<string, unknown>;
  @ApiProperty({ nullable: true, description: 'Job return value (null until completed).' })
  returnValue!: unknown | null;
  @ApiProperty({ type: [String] }) stacktrace!: string[];
  @ApiProperty({ type: [String] }) logs!: string[];
  @ApiProperty({ type: JobOptionsResponse }) opts!: JobOptionsResponse;
}

export class PaginatedJobsResponse {
  @ApiProperty({ type: [JobSummaryResponse] }) items!: JobSummaryResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class BulkActionResultResponse {
  @ApiProperty() succeeded!: number;
  @ApiProperty() failed!: number;
}

export class CleanQueueResponse {
  @ApiProperty({ type: [String], description: 'Ids of the removed jobs.' }) removedJobIds!: string[];
  @ApiProperty() count!: number;
}

/** Generic acknowledgement for fire-and-forget mutations. */
export class SuccessResponse {
  @ApiProperty({ default: true }) success!: boolean;
}

/** TASK-403 — Redis health snapshot for `GET /admin/queues/health/redis`. */
export class RedisHealthInfoResponse {
  @ApiProperty({ enum: ['healthy', 'degraded', 'unhealthy'] }) status!: 'healthy' | 'degraded' | 'unhealthy';
  @ApiProperty({ description: 'PING round-trip in ms (-1 when unreachable).' }) latencyMs!: number;
  @ApiProperty() connectedClients!: number;
  @ApiProperty({ example: '48.31M' }) usedMemory!: string;
  @ApiProperty({ description: 'Server uptime in seconds.' }) uptime!: number;
  @ApiProperty({ example: '7.2.5' }) version!: string;
  @ApiProperty({ description: 'Queues registered in this API process.' }) queuesRegistered!: number;
}
