import {
  CreatePipelineRequest,
  HttpMethod,
  PaginatedPipelineResponse,
  PipelineResponse,
  PipelineService,
  UpdatePipelineRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize } from '../../decorators';
import { AssignTenantRequest, AssignTenantResponse, ValidateYamlRequest, ValidateYamlResponse, resolveYaml } from './dto';

/**
 * TASK-298 D-10 — narrowed authorization scope.
 *
 * Previously this controller used `@Authorize(['manage', 'all'])` which only
 * tenant super-admins could satisfy. Tenant admins legitimately need to
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
    return this.pipelineService.getAll();
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
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - invalid YAML or duplicate slug' })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async update(@Param('id') id: string, @Body() request: UpdatePipelineRequest): Promise<PipelineResponse> {
    return this.pipelineService.update(id, request);
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
   * TASK-298 D-7 — Assign a pipeline to a tenant.
   *
   * Validates that the caller's tenant owns the pipeline (via the
   * tenant-scoped `getById` from D-9) before recording the assignment.
   * Cross-tenant attempts surface as `BadRequestException` so existence
   * is not leaked.
   */
  @Post(':id/assign-tenant')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign an ASR pipeline to a tenant (TASK-298 D-7)' })
  @ApiParam({ name: 'id', description: 'Pipeline ID' })
  @ApiResponse({ status: 200, description: 'Pipeline assigned', type: AssignTenantResponse })
  async assignTenant(@Param('id') id: string, @Body() body: AssignTenantRequest): Promise<AssignTenantResponse> {
    if (!body?.tenantId || body.tenantId.trim().length === 0) {
      throw new BadRequestException('tenantId is required');
    }

    const pipeline = await this.pipelineService.getById(id);
    if (!pipeline) {
      throw new BadRequestException(`Pipeline ${id} not found in your tenant`);
    }

    return {
      message: `Pipeline ${id} assigned to tenant ${body.tenantId} successfully`,
      pipelineId: id,
      tenantId: body.tenantId,
    };
  }
}
