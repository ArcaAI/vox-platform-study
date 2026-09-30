import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CancelModelDownloadRequest, CancelModelDownloadResponse, ListPublisherJobsQuery, ModelPublisherJobsService, PublisherJobView } from '@arcaai/applications';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Model-publisher job control (TASK-1023 R6): `GET admin/ai-models/jobs` and
 * `POST admin/ai-models/:id/download/cancel`.
 *
 * Registered BEFORE `AiModelAdminController` (static paths win over its `:id` family).
 *
 * AUTH-NOTE: `manage:all` understates the gate — the service requires a platform
 * admin (SUPER_ADMIN) with NO working tenant (`assertPlatformRegistryAdmin`).
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-model:manage')
@Controller('admin/ai-models')
@Authorize(['manage', 'all'])
export class AiModelJobsController {
  constructor(private readonly jobs: ModelPublisherJobsService) {}

  @Get('jobs')
  @ApiOperation({
    summary: 'List recent model-publisher jobs',
    description:
      'The recent download and unregister jobs of the model publisher, newest first: BullMQ state merged with the row ' +
      'bookkeeping. A cancelled download reads `cancelled`; a run whose job BullMQ lost is still listed from the row. ' +
      'Platform administrators only, with no working tenant selected.',
  })
  @ApiResponse({ status: 200, type: PublisherJobView, isArray: true })
  @ApiResponse({ status: 400, description: '`limit` is not an integer between 1 and 200.' })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  async listJobs(@Query() query: ListPublisherJobsQuery): Promise<PublisherJobView[]> {
    return this.jobs.listJobs(query.limit);
  }

  @Post(':id/download/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Cancel a model download',
    description:
      'A queued download is removed and the model reads `DOWNLOAD_CANCELLED` at once (`outcome: removed`); a running one ' +
      'is stopped by the publisher worker, which deletes the partial weights and records the cancel (`outcome: cancelling`). ' +
      'Cancelling again while it stops is harmless. `removeRegistration: true` also unregisters the model (weights deleted) ' +
      'once the download is cancelled.',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 202, type: CancelModelDownloadResponse })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: 'Model not found.' })
  @ApiResponse({ status: 409, description: '`JOB_NOT_ACTIVE` — the model has no download in progress to cancel.' })
  async cancelDownload(@Param('id') id: string, @Body() body: CancelModelDownloadRequest): Promise<CancelModelDownloadResponse> {
    return this.jobs.cancelDownload(id, body);
  }
}
