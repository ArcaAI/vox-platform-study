/**
 * ConsultationJobController — TASK-263 / W0-6 (GAP-01)
 *
 * Exposes the existing `IConsultationJobService` over HTTP/SSE at the paths
 * the `@arcaai/vox` SDK already calls (`CONSULTATION_JOB_ENDPOINTS` in
 * `packages/agentic-sdk-v2/src/core/constants.ts`):
 *
 *   GET    /consultations/jobs/:jobId            → job status
 *   PATCH  /consultations/jobs/:jobId/cancel     → cancel pending job
 *   GET    /consultations/jobs/:jobId/stream     → SSE real-time updates
 *
 * Authorisation: any authenticated user (existing pattern for the async
 * summary endpoints in `ConsultationController`). Per-job ownership checks
 * are tracked as a follow-up (TASK-263 §6) once `ConsultationJobStatus`
 * carries `userId`/`tenantId` fields.
 */
import { Controller, Get, Inject, NotFoundException, Param, Patch, Sse, type MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { IConsultationJobService, JobStatusResponse } from '@arcaai/applications';
import { TenantOwnedResource } from '../../common';
import { Authorize } from '../../decorators';
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
  @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId' })
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
  @StreamScope({ namespace: 'consultation_job', param: 'jobId' })
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
