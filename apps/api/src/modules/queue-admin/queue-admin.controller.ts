import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { IJobAdminService, IQueueAdminService, type BulkActionResult, type PaginatedJobResult } from '@arcaai/applications';
import type { JobDetail, QueueStats, RedisHealthInfo } from '@arcaai/domains';
import { Authorize, RequiredScopes } from '../../decorators';
import {
  BulkActionResultResponse,
  BulkJobActionRequest,
  CleanQueueRequest,
  CleanQueueResponse,
  JobDetailResponse,
  ListJobsQuery,
  PaginatedJobsResponse,
  QueueStatsResponse,
  RedisHealthInfoResponse,
  SuccessResponse,
} from './dto';
import { QueueNamePipe } from './pipes/queue-name.pipe';

/**
 * Guarded admin surface over the existing
 * queue-admin application layer (BullMQ queues + jobs). Reachable at
 * `/api/v1/admin/queues`.
 *
 * Access: class-level `@Authorize(['manage','all'])` gates the whole surface to
 * SUPER_ADMIN. Queues/jobs are PLATFORM-wide infrastructure (not tenant-scoped),
 * so — exactly like the rate-limit admin surface — tenant admins (`manage` on a
 * tenant subject) must NOT be able to pause/clean platform queues or inspect
 * cross-tenant job payloads. The `manage all` permission is granted only by the
 * `system-full-access` policy.
 *
 * This controller is a thin delegate: every route forwards to
 * `IQueueAdminService` / `IJobAdminService` and exposes only the actions those
 * services already implement (no obliterate, no raw Redis).
 */
@ApiTags('admin-queues')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@RequiredScopes('admin:queue:manage')
@Controller('admin/queues')
export class QueueAdminController {
  constructor(
    @Inject(IQueueAdminService) private readonly queueService: IQueueAdminService,
    @Inject(IJobAdminService) private readonly jobService: IJobAdminService,
  ) {}

  // ── Queues ───────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List every registered queue with its stats (counts, paused flag, worker count).' })
  @ApiOkResponse({ type: [QueueStatsResponse] })
  listQueues(): Promise<QueueStats[]> {
    return this.queueService.getAllQueueStats();
  }

  // Declared before the dynamic `:queueName` routes so the static
  // `health/redis` segment can never be swallowed by a queue-name match.
  @Get('health/redis')
  @ApiOperation({ summary: 'Redis connection health for the queue infrastructure (PING latency + INFO stats). Never errors.' })
  @ApiOkResponse({ type: RedisHealthInfoResponse })
  getRedisHealth(): Promise<RedisHealthInfo> {
    return this.queueService.getRedisHealth();
  }

  @Get(':queueName')
  @ApiOperation({ summary: 'Get stats for a single queue.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: QueueStatsResponse })
  getQueue(@Param('queueName', QueueNamePipe) queueName: string): Promise<QueueStats> {
    return this.queueService.getQueueStats(queueName);
  }

  @Post(':queueName/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a queue (stops processing new jobs).' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: SuccessResponse })
  async pauseQueue(@Param('queueName', QueueNamePipe) queueName: string): Promise<SuccessResponse> {
    await this.queueService.pauseQueue(queueName);
    return { success: true };
  }

  @Post(':queueName/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused queue.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: SuccessResponse })
  async resumeQueue(@Param('queueName', QueueNamePipe) queueName: string): Promise<SuccessResponse> {
    await this.queueService.resumeQueue(queueName);
    return { success: true };
  }

  @Post(':queueName/clean')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clean finished (completed/failed) jobs older than a grace period.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: CleanQueueResponse })
  async cleanQueue(@Param('queueName', QueueNamePipe) queueName: string, @Body() body: CleanQueueRequest): Promise<CleanQueueResponse> {
    const removedJobIds = await this.queueService.cleanQueue(queueName, body.status, body.gracePeriodMs, body.limit);
    return { removedJobIds, count: removedJobIds.length };
  }

  // ── Jobs (nested under their queue) ───────────────────────────────────────

  @Get(':queueName/jobs')
  @ApiOperation({ summary: 'List jobs in a queue (paginated, optionally status/name filtered).' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: PaginatedJobsResponse })
  listJobs(@Param('queueName', QueueNamePipe) queueName: string, @Query() query: ListJobsQuery): Promise<PaginatedJobResult> {
    return this.jobService.listJobs(queueName, query);
  }

  @Post(':queueName/jobs/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a bulk retry/remove action to a set of job ids.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiOkResponse({ type: BulkActionResultResponse })
  bulkJobAction(@Param('queueName', QueueNamePipe) queueName: string, @Body() body: BulkJobActionRequest): Promise<BulkActionResult> {
    return this.jobService.bulkAction(queueName, body.action, body.jobIds);
  }

  @Get(':queueName/jobs/:jobId')
  @ApiOperation({ summary: 'Get a single job with PII-redacted data, options, stacktrace.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id.' })
  @ApiOkResponse({ type: JobDetailResponse })
  getJob(@Param('queueName', QueueNamePipe) queueName: string, @Param('jobId') jobId: string): Promise<JobDetail> {
    return this.jobService.getJobDetail(queueName, jobId);
  }

  @Post(':queueName/jobs/:jobId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed job (re-uses the original payload).' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id.' })
  @ApiOkResponse({ type: SuccessResponse })
  async retryJob(@Param('queueName', QueueNamePipe) queueName: string, @Param('jobId') jobId: string): Promise<SuccessResponse> {
    await this.jobService.retryJob(queueName, jobId);
    return { success: true };
  }

  @Post(':queueName/jobs/:jobId/promote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Promote a delayed job so it runs immediately.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id.' })
  @ApiOkResponse({ type: SuccessResponse })
  async promoteJob(@Param('queueName', QueueNamePipe) queueName: string, @Param('jobId') jobId: string): Promise<SuccessResponse> {
    await this.jobService.promoteJob(queueName, jobId);
    return { success: true };
  }

  @Delete(':queueName/jobs/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a job from the queue.' })
  @ApiParam({ name: 'queueName', description: 'Registered JobQueue name.' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job id.' })
  @ApiOkResponse({ type: SuccessResponse })
  async removeJob(@Param('queueName', QueueNamePipe) queueName: string, @Param('jobId') jobId: string): Promise<SuccessResponse> {
    await this.jobService.removeJob(queueName, jobId);
    return { success: true };
  }
}
