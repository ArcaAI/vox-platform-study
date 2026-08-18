import {
  CreateWebhookRequest,
  IWebhookService,
  PaginatedQuery,
  PaginatedWebhookResponse,
  PaginatedWebhookRunHistoryResponse,
  RotateWebhookSecretRequest,
  UpdateWebhookRequest,
  WebhookDtoMapper,
  WebhookResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey } from '../../decorators';
import { CreateWebhookResponse } from './dto';

/**
 * WebhookController — admin CRUD + delivery-log surface over
 * the pre-existing `WebhookService`, mounted at `/admin/webhooks` (global
 * prefix → `/api/v1/admin/webhooks`). Mirrors `ApiKeyController` (mapper at
 * the edge) and `DepartmentController` (If-Match OCC fold on PATCH).
 *
 * Tenancy is service-enforced: lists pin non-SUPER_ADMIN callers to the CLS
 * tenant, id reads/writes are load-then-assert (cross-tenant → 404, no
 * existence leak). CASL: class-level `manage:Webhook` (tenant-full-access
 * grants it tenant-scoped); the delivery log is `read:WebhookRunHistory`.
 */
@ApiBearerAuth()
@ApiTags('admin-webhooks')
@ForbidApiKey()
@Controller('admin/webhooks')
@CanManage('Webhook')
export class WebhookController {
  constructor(
    @Inject(IWebhookService)
    private readonly webhookService: IWebhookService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a webhook for the caller tenant. The signing secret is server-generated and returned only once.' })
  @ApiResponse({ status: 201, description: 'Webhook created. Raw signing secret returned only once.', type: CreateWebhookResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input.' })
  async create(@Body() request: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    const result = await this.webhookService.create(request);
    return { webhook: WebhookDtoMapper.ToResponse(result.webhook), rawSecret: result.rawSecret };
  }

  @Get()
  @ApiOperation({ summary: 'List webhooks (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Cross-tenant target (SUPER_ADMIN only — others 404).' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWebhookResponse })
  async fetchAll(@Query() query: PaginatedQuery & { tenantId?: string }): Promise<PaginatedWebhookResponse> {
    const { tenantId, ...paginated } = query;
    const props = { ...paginated, sort: query.sort || 'updatedAt:desc' };
    const result = tenantId ? await this.webhookService.fetchAllByTenantId({ ...props, tenantId }) : await this.webhookService.fetchAll(props);
    return WebhookDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one webhook' })
  @ApiParam({ name: 'id', description: 'Webhook id' })
  @ApiResponse({ status: 200, type: WebhookResponse })
  @ApiResponse({ status: 404, description: 'Webhook not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<WebhookResponse> {
    const result = await this.webhookService.fetchById(id);
    return WebhookDtoMapper.ToResponse(result);
  }

  @Get(':id/deliveries')
  @Authorize(['read', 'WebhookRunHistory'])
  @ApiOperation({
    summary: "List a webhook's delivery log (newest-first)",
    description:
      'Read-only projection of `WebhookRunHistory`. Rows carry no tenantId — tenancy is enforced through the parent webhook (cross-tenant id → 404).',
  })
  @ApiParam({ name: 'id', description: 'Webhook id' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedWebhookRunHistoryResponse })
  @ApiResponse({ status: 404, description: 'Webhook not found (or cross-tenant).' })
  async fetchDeliveries(@Param('id') id: string, @Query() query: PaginatedQuery): Promise<PaginatedWebhookRunHistoryResponse> {
    const result = await this.webhookService.fetchRunHistory(id, query);
    return WebhookDtoMapper.ToPaginatedRunHistoryResponse(result);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a webhook (If-Match OCC)',
    description:
      'Sparse patch. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED and ' +
      "CAS'es against the row `_version`; drift → 412, missing header → 428.",
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'Webhook id' })
  @ApiResponse({ status: 200, type: WebhookResponse })
  @ApiResponse({ status: 404, description: 'Webhook not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateWebhookRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<WebhookResponse> {
    const effectiveRequest: UpdateWebhookRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    const result = await this.webhookService.update(id, effectiveRequest);
    return WebhookDtoMapper.ToResponse(result);
  }

  @Post(':id/rotate-secret')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Rotate a webhook signing secret (If-Match OCC)',
    description:
      'Mints a fresh, server-generated signing secret and invalidates the prior one immediately (no overlap window). ' +
      'The raw secret is returned exactly once, same contract as `POST admin/webhooks`. Optimistic concurrency is enforced ' +
      'identically to `PATCH :id`: `If-Match` (RFC 7232) is REQUIRED; drift → 412, missing header → 428.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'Webhook id' })
  @ApiResponse({ status: 201, description: 'Secret rotated. Raw signing secret returned only once.', type: CreateWebhookResponse })
  @ApiResponse({ status: 404, description: 'Webhook not found (or cross-tenant).' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async rotateSecret(
    @Param('id') id: string,
    @Body() request: RotateWebhookSecretRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<CreateWebhookResponse> {
    const expectedVersion = expectedFromHeader ?? request.expectedVersion;
    const result = await this.webhookService.rotateSecret(id, expectedVersion);
    return { webhook: WebhookDtoMapper.ToResponse(result.webhook), rawSecret: result.rawSecret };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a webhook' })
  @ApiParam({ name: 'id', description: 'Webhook id' })
  @ApiResponse({ status: 200, type: WebhookResponse })
  @ApiResponse({ status: 404, description: 'Webhook not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<WebhookResponse> {
    const result = await this.webhookService.deleteById(id);
    return WebhookDtoMapper.ToResponse(result);
  }
}
