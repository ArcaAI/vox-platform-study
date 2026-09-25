import { ListTranscriptionJobsQuery, TranscriptionJobService } from '@arcaai/applications';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

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
 *   - Each read carries a handler-level `@CanRead('TranscriptionJob')`
 *     which OVERRIDES the class gate (the guard uses `getAllAndOverride`).
 *     A class-only `manage Tenant` had locked tenant admins out (the seed gives
 *     them read/update Tenant, not manage); the policy seed grants them
 *     `TranscriptionJob` for exactly these reads.
 *
 * TASK-1006: the subject is the resource these routes read. It was
 * `AsrPipeline`, the retired pipeline stack's subject, which outlived the
 * tables it named.
 *
 * Tenant isolation:
 *   - The `tenantScopeFilter` Prisma extension injects `tenantId` into every
 *     read, so these tenant-wide queries can never cross a tenant boundary.
 */
@ApiBearerAuth()
@ApiTags('admin-transcription-jobs')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:transcription-job:read')
@Controller('admin/audio/transcription-jobs')
@CanManage('Tenant')
export class AdminTranscriptionJobController {
  constructor(private readonly jobService: TranscriptionJobService) {}

  /**
   * TASK-999 (D-5(a)) — the list now carries BOTH kinds: batch jobs and the
   * realtime sessions that became `jobType = STREAMING` rows.
   *
   * `page`/`limit`/`jobType` moved onto a validated DTO because the global pipe
   * runs `whitelist + forbidNonWhitelisted`: an undeclared query field must 400
   * rather than be silently dropped, which is what three loose `@Query('name')`
   * params did. `page` and `limit` keep their names and defaults, so the
   * console's existing call is byte-identical.
   */
  @Get()
  @CanRead('TranscriptionJob')
  @ApiOperation({
    summary: 'List ALL transcription jobs in the tenant (paginated)',
    description:
      'Tenant-wide list of transcription jobs. Since TASK-999 this includes realtime sessions (`jobType = STREAMING`) alongside batch jobs; pass `jobType` to restrict to one kind, omit it for both.',
  })
  async list(@Query() query: ListTranscriptionJobsQuery) {
    return this.jobService.list(query.page ?? 1, query.limit ?? 20, query.jobType);
  }

  @Get('stats')
  @CanRead('TranscriptionJob')
  @ApiOperation({ summary: 'Get tenant-wide transcription job status counts' })
  async getStats() {
    return this.jobService.getStatusCounts();
  }

  @Get('status/:status')
  @CanRead('TranscriptionJob')
  @ApiOperation({ summary: 'Get tenant-wide transcription jobs by status' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatus(status as any);
  }
}
