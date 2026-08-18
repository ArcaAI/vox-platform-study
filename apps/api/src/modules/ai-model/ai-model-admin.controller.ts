import { AiModelService, CreateModelRequest, HttpMethod, ModelResponse, PaginatedModelResponse, UpdateModelRequest } from '@arcaai/applications';
import { Body, Controller, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey } from '../../decorators';

/**
 * Admin AI model catalog controller.
 *
 * Mirrors `audio-pipeline.controller.ts` 1:1: a thin delegation surface over
 * the already-existing `AiModelService`.
 *
 * Authorization: the registry is a SUPER_ADMIN plane — the guard is
 * pinned to `manage:all`, and the tenant-scoped `manage:AiModel` grant no
 * longer opens this controller. Super Admins manage per-tenant clones of the
 * SYSTEM catalog through the working-tenant context. Event broadcasting +
 * exact-tenant scoping live in the service / Prisma `tenant-scope` extension;
 * OCC is enforced via the `If-Match` header.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@Controller('admin/ai-models')
@Authorize(['manage', 'all'])
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
    // the EXACT caller tenant: a disabled model stays
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
  async fetchById(@Param('id') id: string): Promise<ModelResponse> {
    const model = await this.aiModelService.getById(id);
    if (!model) {
      // A null service result used to serialize as HTTP 200
      // with an EMPTY body; an absent row is a 404.
      throw new NotFoundException(`Model '${id}' not found`);
    }
    return model;
  }

  @ApiEndpoint({
    returnedModel: ModelResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Model slug', type: String })
  @ApiResponse({ status: 404, description: 'Model not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<ModelResponse> {
    const model = await this.aiModelService.getBySlug(slug);
    if (!model) {
      // See fetchById: null must be a 404, not a 200-empty.
      throw new NotFoundException(`Model with slug '${slug}' not found`);
    }
    return model;
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
      'Updates one AiModel row. Optimistic concurrency is enforced: ' +
      'the `If-Match` header (RFC 7232) is REQUIRED, and the server ' +
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
    const effectiveRequest: UpdateModelRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
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
