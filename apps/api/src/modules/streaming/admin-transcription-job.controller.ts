import { TranscriptionJobService } from '@arcaai/applications';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CanManage } from '../../decorators';

/**
 * TASK-319 F3 — admin transcription-job surface (tenant-wide scope).
 *
 * Separate-controller (Pattern A) admin counterpart to
 * {@link TranscriptionJobController}. Where the end-user controller scopes
 * list/stats/status to the caller (`createdBy = self`), this surface reports
 * EVERY job in the caller's tenant.
 *
 * Access:
 *   - Class-level `@CanManage('Tenant')` → only TENANT_ADMIN / SUPER_ADMIN.
 *     `TranscriptionJob` is not a CASL subject in the policy seed, so the
 *     tenant-wide view is gated on the tenant-management capability (the same
 *     posture used for other tenant-scoped admin reads). This also satisfies
 *     the F6 boot audit, which rejects an empty `@Authorize()` on /admin routes.
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
  @ApiOperation({ summary: 'List ALL transcription jobs in the tenant (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('page') page: number = 1, @Query('limit') limit: number = 20) {
    return this.jobService.list(page, limit);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get tenant-wide transcription job status counts' })
  async getStats() {
    return this.jobService.getStatusCounts();
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get tenant-wide transcription jobs by status' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatus(status as any);
  }
}
