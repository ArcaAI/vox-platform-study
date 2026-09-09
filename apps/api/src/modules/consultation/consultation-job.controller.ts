/**
 * ConsultationJobController
 *
 * Exposes the existing `IConsultationJobService` over HTTP/SSE at the paths
 * the `@arcaai/vox` SDK already calls (`CONSULTATION_JOB_ENDPOINTS` in
 * `packages/agentic-sdk-v2/src/core/constants.ts`):
 *
 *   GET    /consultations/jobs/:jobId            → job status
 *   PATCH  /consultations/jobs/:jobId/cancel     → cancel pending job
 *   GET    /consultations/jobs/:jobId/stream     → SSE real-time updates
 *
 * Authorisation: `@Authorize()` at the class level + per-method
 * `@TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId' })`.
 * `userId` / `tenantId` live on `ConsultationJobStatus` (see
 * `packages/applications/src/services/consultation/jobs/dto/job.dto.ts`)
 * so the interceptor can resolve the per-job tenant from Redis and 404 on
 * cross-tenant mismatch.
 */
import { Controller, Get, Inject, NotFoundException, Param, Patch, Sse, type MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { IConsultationJobService, JobStatusResponse } from '@arcaai/applications';
import { TenantOwnedResource } from '../../common';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { StreamScope } from '../auth';

@ApiBearerAuth()
@ApiTags('consultation-jobs')
@Controller('consultations/jobs')
@Authorize()
export class ConsultationJobController {
  constructor(
    @Inject(IConsultationJobService)
    private readonly jobService: IConsultationJobService,
  ) {}

  @Get(':jobId')
  @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId' })
  @RequiredScopes('consultation:session:read')
  // TASK-933 — the async note job is a REPORT read, which is what the machine class is granted
  // here (`svc:consultation:report:read`); the API-key scope stays the historical
  // `consultation:session:read` because narrowing a live key's reach is not this ticket's to do.
  // `cancelJob` is deliberately NOT opened: it carries `scope: 'creator'`, so it is the
  // clinician's own control over their own job, and deny-by-default keeps it that way.
  @RequiredSvcScopes('svc:consultation:report:read')
  @ApiOperation({ summary: 'Get the current status of an async consultation job' })
  @ApiParam({ name: 'jobId', description: 'Job ID returned by an async summary/pre-summary/comprehensive/NER endpoint' })
  @ApiResponse({ status: 200, description: 'Job status payload', type: JobStatusResponse })
  @ApiResponse({ status: 404, description: 'Job not found or expired' })
  async getJob(@Param('jobId') jobId: string): Promise<JobStatusResponse> {
    const status = await this.jobService.getJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return status;
  }

  @Patch(':jobId/cancel')
  // `scope: 'creator'` upgrades the tenant-only check to an
  // intra-tenant owner check on this mutating route. A same-tenant peer
  // probing this jobId now 404s (DEF-C3) instead of cancelling someone
  // else's job. The read routes (`getJob`, `streamJob`) intentionally stay
  // tenant-only because shared-room reads from peer users are legitimate.
  @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId', scope: 'creator' })
  @RequiredScopes('consultation:session:read')
  @ApiOperation({ summary: 'Cancel a pending or running async consultation job' })
  @ApiParam({ name: 'jobId', description: 'Job ID to cancel' })
  @ApiResponse({ status: 200, description: 'Cancellation acknowledgement' })
  @ApiResponse({ status: 404, description: 'Job not found, already terminal, or not cancellable' })
  async cancelJob(@Param('jobId') jobId: string): Promise<{ ok: true }> {
    const cancelled = await this.jobService.cancelJob(jobId);
    if (!cancelled) {
      throw new NotFoundException(`Job ${jobId} not found or no longer cancellable`);
    }
    return { ok: true };
  }

  @Get(':jobId/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId' })
  @RequiredScopes('consultation:session:read')
  @StreamScope({ namespace: 'consultation_job', param: 'jobId' })
  @RequiredSvcScopes('svc:consultation:report:read')
  @ApiOperation({
    summary: 'Stream real-time status updates for an async consultation job via SSE',
    description:
      'Server-Sent Events stream. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_job:<jobId>`.',
  })
  @ApiParam({ name: 'jobId', description: 'Job ID to subscribe to' })
  streamJob(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return this.jobService.subscribeToJobUpdates(jobId);
  }
}
