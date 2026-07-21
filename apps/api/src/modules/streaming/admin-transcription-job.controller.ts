import { TranscriptionJobService } from '@arcaai/applications';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead } from '../../decorators';

/**
 * Admin transcription-job surface (tenant-wide scope).
 *
 * Separate-controller (Pattern A) admin counterpart to
 * {@link TranscriptionJobController}. Where the end-user controller scopes
 * list/stats/status to the caller (`createdBy = self`), this surface reports
 * EVERY job in the caller's tenant.
 *
 * Access:
 *   - Class-level `@CanManage('Tenant')` documents the admin plane and keeps
 *     the F6 boot audit satisfied (no empty `@Authorize()` on /admin routes),
 *     exactly like `TenantBucketController`.
 *   - Each read carries a handler-level `@CanRead('AsrPipeline')`
 *     which OVERRIDES the class gate (the guard uses `getAllAndOverride`).
 *     `TranscriptionJob` is not a CASL subject; the audio surface is scoped on
 *     `AsrPipeline` per the §5.8 design permissions, which `tenant-full-access`
 *     grants tenant admins — a class-only `manage Tenant` had locked them out
 *     (the seed gives tenant admins read/update Tenant, not manage).
 *
 * Tenant isolation:
 *   - The `tenantScopeFilter` Prisma extension injects `tenantId` into every
 *     read, so these tenant-wide queries can never cross a tenant boundary.
 */
@ApiBearerAuth()
@ApiTags('admin-transcription-jobs')
@Controller('admin/audio/transcription-jobs')
@CanManage('Tenant')
export class AdminTranscriptionJobController {
  constructor(private readonly jobService: TranscriptionJobService) {}

  @Get()
  @CanRead('AsrPipeline')
  @ApiOperation({ summary: 'List ALL transcription jobs in the tenant (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('page') page: number = 1, @Query('limit') limit: number = 20) {
    return this.jobService.list(page, limit);
  }

  @Get('stats')
  @CanRead('AsrPipeline')
  @ApiOperation({ summary: 'Get tenant-wide transcription job status counts' })
  async getStats() {
    return this.jobService.getStatusCounts();
  }

  @Get('status/:status')
  @CanRead('AsrPipeline')
  @ApiOperation({ summary: 'Get tenant-wide transcription jobs by status' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatus(status as any);
  }
}
