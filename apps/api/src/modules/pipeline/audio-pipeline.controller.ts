import {
  CreatePipelineRequest,
  HttpMethod,
  PaginatedPipelineResponse,
  PipelineResponse,
  PipelineService,
  PipelineVersionResponse,
  TogglePipelineRequest,
  UpdatePipelineRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';
import { AssignTenantRequest, AssignTenantResponse, ValidateYamlRequest, ValidateYamlResponse, resolveYaml } from './dto';

/**
 * TASK-298 D-10 — narrowed authorization scope.
 *
 * Previously this controller used `@Authorize(['manage', 'all'])` which only
 * tenant global-admins could satisfy. Tenant admins legitimately need to
 * self-serve their ASR pipelines, so we narrow the subject to `AsrPipeline`.
 */
@ApiBearerAuth()
@ApiTags('admin-audio-pipelines')
@Controller('admin/audio/pipelines')
@Authorize(['manage', 'AsrPipeline'])
export class AudioPipelineController {
  constructor(private readonly pipelineService: PipelineService) {}

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid YAML or duplicate slug' })
  async create(@Body() request: CreatePipelineRequest): Promise<PipelineResponse> {
    return this.pipelineService.create(request);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    multi: true,
  })
  async fetchAll(): Promise<PipelineResponse[]> {
    // IC-02 — the admin surface lists pipelines of ALL statuses (ENABLED +
    // DISABLED) so a disabled pipeline stays visible and can be re-enabled.
    // The public controller keeps the enabled-only `getAll`.
    return this.pipelineService.getAllForAdmin();
  }

  @ApiEndpoint({
    returnedModel: PaginatedPipelineResponse,
    path: 'list',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  async list(@Query('page') page?: string, @Query('limit') limit?: string): Promise<PaginatedPipelineResponse> {
    return this.pipelineService.list(page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 20);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async fetchById(@Param('id') id: string): Promise<PipelineResponse | null> {
    return this.pipelineService.getById(id);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Pipeline slug', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<PipelineResponse | null> {
    return this.pipelineService.getBySlug(slug);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update an ASR pipeline',
    description:
      'Updates one AsrPipeline row. Optimistic concurrency is enforced ' +
      '(TASK-302 Stream D Phase E.4): the `If-Match` header (RFC 7232) is ' +
      "REQUIRED, and the server runs a Compare-And-Set against the row's " +
      '`_version` column. When the header is present, its value overrides the ' +
      'body-field `expectedVersion`. On version drift the response is `412 ' +
      'Precondition Failed`; missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - invalid YAML or duplicate slug' })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdatePipelineRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PipelineResponse> {
    // TASK-302 Stream D Phase E.4 — header takes precedence over body
    // when both are present. On a `@RequiresIfMatch()` route the param
    // decorator fired 428 if the header was missing.
    const effectiveRequest: UpdatePipelineRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.pipelineService.update(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.pipelineService.delete(id);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    method: HttpMethod.POST,
    path: 'validate',
  })
  @ApiResponse({ status: 200, description: 'YAML validation result', type: ValidateYamlResponse })
  async validateYaml(@Body() body: ValidateYamlRequest): Promise<ValidateYamlResponse> {
    // TASK-298 D-6 — accept either `configYaml` (SDK) or `yaml` (legacy).
    return this.pipelineService.validateYaml(resolveYaml(body));
  }

  /**
   * IC-04 (TASK-336) — Assign a pipeline within its owning tenant.
   *
   * Previously a no-op stub that echoed success without persisting anything.
   * Real persistence now lives in the service: `AsrPipeline` has a single,
   * deliberately protected `tenantId` (BaseTenantEntity, TASK-305), so a
   * cross-tenant transfer is unsupported and is rejected; a same-tenant
   * assignment is persisted by promoting the pipeline to the tenant default.
   */
  @Post(':id/assign-tenant')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign an ASR pipeline within its tenant (IC-04 / TASK-336)' })
  @ApiParam({ name: 'id', description: 'Pipeline ID' })
  @ApiResponse({ status: 200, description: 'Pipeline assigned', type: AssignTenantResponse })
  async assignTenant(@Param('id') id: string, @Body() body: AssignTenantRequest): Promise<AssignTenantResponse> {
    const targetTenantId = body?.tenantId ?? '';
    const updated = await this.pipelineService.assignToTenant(id, targetTenantId);

    return {
      message: `Pipeline ${id} assigned to tenant ${targetTenantId} (now the tenant default)`,
      pipelineId: updated.id,
      tenantId: targetTenantId,
    };
  }

  // ============================================================
  // TASK-328 A6 — default / toggle / versioning
  // ============================================================

  /**
   * Mark a pipeline as the tenant default (unsets the previous default
   * atomically). This is a tenant-scoped flag flip — NOT a content edit — so
   * it deliberately does not require `If-Match`.
   */
  @Post(':id/set-default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a pipeline as the tenant default (TASK-328 A6)' })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 200, description: 'Pipeline marked as default', type: PipelineResponse })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async setDefault(@Param('id') id: string): Promise<PipelineResponse> {
    return this.pipelineService.setDefault(id);
  }

  /**
   * Enable/disable a pipeline (flips `resourceStatus`). OCC-guarded: the
   * `If-Match` header is REQUIRED and folds into the CAS predicate.
   */
  @Patch(':id/toggle')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Enable/disable a pipeline (TASK-328 A6)',
    description:
      'Flips the pipeline `resourceStatus` (ENABLED ⇄ DISABLED). Optimistic ' +
      'concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED ' +
      'and runs a Compare-And-Set against the row `_version`. Drift → `412`, ' +
      'missing header → `428`.',
  })
  @ApiHeader({ name: 'If-Match', description: 'RFC 7232 strong validator carrying the row version (e.g. `"7"`).', required: true, example: '"7"' })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 200, description: 'Pipeline status updated', type: PipelineResponse })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async toggle(
    @Param('id') id: string,
    @Body() body: TogglePipelineRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PipelineResponse> {
    return this.pipelineService.toggle(id, body.enabled, expectedFromHeader);
  }

  /**
   * List config-version snapshots for a pipeline (newest first).
   */
  @Get(':id/versions')
  @ApiOperation({ summary: 'List config-version snapshots for a pipeline (TASK-328 A6)' })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 200, description: 'Version snapshots (newest first)', type: PipelineVersionResponse, isArray: true })
  async listVersions(@Param('id') id: string): Promise<PipelineVersionResponse[]> {
    return this.pipelineService.listVersions(id);
  }

  /**
   * Fetch a single config-version snapshot by version number.
   */
  @Get(':id/versions/:versionNumber')
  @ApiOperation({ summary: 'Get one config-version snapshot by version number (TASK-328 A6)' })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiParam({ name: 'versionNumber', description: 'Version number (1-based)', type: Number })
  @ApiResponse({ status: 200, description: 'Version snapshot', type: PipelineVersionResponse })
  @ApiResponse({ status: 404, description: 'Version not found' })
  async getVersion(@Param('id') id: string, @Param('versionNumber') versionNumber: string): Promise<PipelineVersionResponse> {
    const parsed = Number.parseInt(versionNumber, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('versionNumber must be a positive integer');
    }
    const version = await this.pipelineService.getVersion(id, parsed);
    if (!version) {
      throw new NotFoundException(`Version ${parsed} not found for pipeline ${id}`);
    }
    return version;
  }
}
