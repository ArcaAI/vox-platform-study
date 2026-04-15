import {
  CreatePipelineRequest,
  HttpMethod,
  PaginatedPipelineResponse,
  PipelineResponse,
  PipelineService,
  UpdatePipelineRequest,
} from '@arcaai/applications';
import { Body, Controller, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, CanCreate, CanDelete, CanUpdate } from '../../decorators';
import { ValidateYamlRequest, ValidateYamlResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-audio-pipelines')
@Controller('admin/audio/pipelines')
@Authorize(['manage', 'all'])
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
    path: 'validate-yaml',
  })
  @ApiResponse({ status: 200, description: 'YAML validation result', type: ValidateYamlResponse })
  async validateYaml(@Body() body: ValidateYamlRequest): Promise<ValidateYamlResponse> {
    return this.pipelineService.validateYaml(body.yaml);
  }
}
