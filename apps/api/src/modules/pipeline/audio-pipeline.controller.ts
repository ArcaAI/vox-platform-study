import {
  ClonePipelineRequest,
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
import { ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch, RequiredScopes } from '../../decorators';
import { AssignTenantRequest, AssignTenantResponse, ValidateYamlRequest, ValidateYamlResponse, resolveYaml } from './dto';

/**
 * Narrowed authorization scope: `@Authorize(['manage', 'all'])` would only
 * be satisfiable by tenant super-admins. Tenant admins legitimately need to
 * self-serve their ASR pipelines, so the subject is narrowed to `AsrPipeline`.
 */
@ApiBearerAuth()
@ApiTags('admin-audio-pipelines')
@RequiredScopes('admin:audio-pipeline:manage')
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
  async fetchById(@Param('id') id: string): Promise<PipelineResponse> {
    const pipeline = await this.pipelineService.getById(id);
    if (!pipeline) {
      // A null service result used to serialize as HTTP 200 with an EMPTY
      // body (unparseable as JSON); an absent row is a 404.
      throw new NotFoundException(`Pipeline '${id}' not found`);
    }
    return pipeline;
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Pipeline slug', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<PipelineResponse> {
    const pipeline = await this.pipelineService.getBySlug(slug);
    if (!pipeline) {
      // See fetchById: null must be a 404, not a 200-empty.
      throw new NotFoundException(`Pipeline with slug '${slug}' not found`);
    }
    return pipeline;
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
      'Updates one AsrPipeline row. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is ' +
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
  @ApiResponse({
    status: 403,
    description: 'Template copy is read-only — clone it to customize. Enable/disable and set-default remain available on a locked copy.',
  })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdatePipelineRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PipelineResponse> {
    // Header takes precedence over body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator fired 428 if the
    // header was missing.
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
  @ApiResponse({ status: 403, description: 'Template copy is read-only — clone it to customize.' })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.pipelineService.delete(id);
  }

  /**
   * Clone a pipeline into a new, editable copy.
   *
   * This is the tenant admin's way to customize a locked template copy: the
   * clone is unlocked, keeps the source's template provenance, and inherits the
   * source's current config as its own v1 snapshot. The class-level
   * `@Authorize(['manage','AsrPipeline'])` already scopes this to pipeline
   * admins, which matches owner expectation E4 ("can clone/copy or create their
   * own") — cloning is allowed even though the SOURCE may be locked.
   */
  @Post(':id/clone')
  @ApiOperation({
    summary: 'Clone a pipeline into a new editable copy',
    description:
      'Creates a NEW pipeline from an existing one. The copy is never ' +
      '`templateLocked`, carries the source `sourceTemplateSlug` forward, and ' +
      "starts with the source's current config as its v1 version snapshot. " +
      'Counts against the `maxAsrPipelines` plan quota like any other create.',
  })
  @ApiParam({ name: 'id', description: 'Source pipeline ID', type: String })
  @ApiResponse({ status: 201, description: 'Clone created', type: PipelineResponse })
  @ApiResponse({ status: 400, description: 'Bad request - duplicate slug or invalid name/slug' })
  @ApiResponse({ status: 404, description: 'Source pipeline not found' })
  @ApiResponse({ status: 409, description: 'Plan quota exceeded (maxAsrPipelines)' })
  async clone(@Param('id') id: string, @Body() request: ClonePipelineRequest): Promise<PipelineResponse> {
    return this.pipelineService.clone(id, request);
  }

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    method: HttpMethod.POST,
    path: 'validate',
  })
  @ApiResponse({ status: 200, description: 'YAML validation result', type: ValidateYamlResponse })
  async validateYaml(@Body() body: ValidateYamlRequest): Promise<ValidateYamlResponse> {
    // Accept either `configYaml` (SDK) or `yaml` (legacy).
    return this.pipelineService.validateYaml(resolveYaml(body));
  }

  /**
   * IC-04 — Assign a pipeline within its owning tenant.
   *
   * `AsrPipeline` has a single, deliberately protected `tenantId`
   * (BaseTenantEntity), so a cross-tenant transfer is unsupported and is
   * rejected; a same-tenant assignment is persisted by promoting the
   * pipeline to the tenant default.
   */
  @Post(':id/assign-tenant')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign an ASR pipeline within its tenant' })
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
  // Default / toggle / versioning
  // ============================================================

  /**
   * Mark a pipeline as the tenant default (unsets the previous default
   * atomically). This is a tenant-scoped flag flip — NOT a content edit — so
   * it deliberately does not require `If-Match`.
   */
  @Post(':id/set-default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a pipeline as the tenant default' })
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
    summary: 'Enable/disable a pipeline',
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
  @ApiOperation({ summary: 'List config-version snapshots for a pipeline' })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 200, description: 'Version snapshots (newest first)', type: PipelineVersionResponse, isArray: true })
  async listVersions(@Param('id') id: string): Promise<PipelineVersionResponse[]> {
    return this.pipelineService.listVersions(id);
  }

  /**
   * Fetch a single config-version snapshot by version number.
   */
  @Get(':id/versions/:versionNumber')
  @ApiOperation({ summary: 'Get one config-version snapshot by version number' })
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
