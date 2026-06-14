import {
  AiModelService,
  CreateModelRequest,
  HttpMethod,
  ModelResponse,
  PaginatedModelResponse,
  UpdateModelRequest,
} from '@arcaai/applications';
import { Body, Controller, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * TASK-356 Phase 1 (Catalog plane) — admin AI model catalog controller.
 *
 * Mirrors `audio-pipeline.controller.ts` 1:1: a thin delegation surface over
 * the already-existing `AiModelService`. Authorization is narrowed to the
 * `AiModel` subject so tenant admins can self-serve their own tenant's clone
 * of the SYSTEM catalog (SUPER_ADMIN is covered by the `manage:all` grant).
 * Event broadcasting + exact-tenant scoping live in the service / Prisma
 * `tenant-scope` extension; OCC is enforced via the `If-Match` header.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@Controller('admin/ai-models')
@Authorize(['manage', 'AiModel'])
export class AiModelAdminController {
  constructor(private readonly aiModelService: AiModelService) {}

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - duplicate slug' })
  async create(@Body() request: CreateModelRequest): Promise<ModelResponse> {
    return this.aiModelService.create(request);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    multi: true,
  })
  async fetchAll(): Promise<ModelResponse[]> {
    // The admin surface lists models of ALL statuses (ENABLED + DISABLED) for
    // the EXACT caller tenant (TASK-356 Phase 1): a disabled model stays
    // visible/re-enableable, and a tenant admin sees only its own clone — never
    // the SYSTEM original. The public, enabled-only `getAll` is unaffected.
    return this.aiModelService.getAllForAdmin();
  }

  @ApiEndpoint({
    returnedModel: PaginatedModelResponse,
    path: 'list',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  async list(@Query('page') page?: string, @Query('limit') limit?: string): Promise<PaginatedModelResponse> {
    return this.aiModelService.list(page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 20);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async fetchById(@Param('id') id: string): Promise<ModelResponse | null> {
    return this.aiModelService.getById(id);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Model slug', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<ModelResponse | null> {
    return this.aiModelService.getBySlug(slug);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update an AI model',
    description:
      'Updates one AiModel row. Optimistic concurrency is enforced (TASK-356 ' +
      'Phase 1): the `If-Match` header (RFC 7232) is REQUIRED, and the server ' +
      "runs a Compare-And-Set against the row's `_version` column. When the " +
      'header is present, its value overrides the body-field `expectedVersion`. ' +
      'On version drift the response is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - duplicate slug' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateModelRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ModelResponse> {
    // The header takes precedence over the body when both are present. On a
    // `@RequiresIfMatch()` route the param decorator already fired 428 if the
    // header was missing (mirrors the pipeline OCC contract).
    const effectiveRequest: UpdateModelRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.aiModelService.update(id, effectiveRequest);
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    method: HttpMethod.DELETE,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Model ID', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.aiModelService.delete(id);
  }
}
