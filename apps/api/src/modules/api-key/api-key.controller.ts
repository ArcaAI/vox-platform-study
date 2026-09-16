import {
  ApiKeyDtoMapper,
  ApiKeyResponse,
  ApiKeyScopesCatalogResponse,
  CreateApiKeyRequest,
  getApiKeyScopesCatalog,
  HttpMethod,
  IActiveUserContext,
  IApiKeyService,
  PaginatedApiKeyResponse,
  PaginatedQuery,
  UpdateApiKeyRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  ApiEndpoint,
  CanCreate,
  CanManage,
  CanRead,
  CanUpdate,
  CanDelete,
  ForbidApiKey,
  RequiredSvcScopes,
  ResolveSubjectInstance,
} from '../../decorators';
import type { SubjectResolverContext } from '../../decorators';
import { CreateApiKeyResponse, ApiKeyUsageResponse } from './dto';

/**
 * The class-level `@RequiredSvcScopes('svc:admin:apikey:write')` is the DEFAULT
 * for every route here; the four read routes additionally accept the `:read`
 * twin (decision O-3, 2026-08-19).
 *
 * `enforceServiceAccountScopes` matches with OR semantics
 * (`required.some(...)`), so listing BOTH is what makes a read-only grant work
 * WITHOUT taking anything away from a `:write` holder — declaring only
 * `svc:admin:apikey:read` on a GET would have LOCKED OUT every existing
 * `:write`-scoped account. The pair is therefore the whole mechanism, not a
 * belt-and-braces flourish, and boot audit H accepts exactly this shape (and
 * only on a method: the pair at CLASS level would let a `:read` token POST).
 *
 * Sound here because the abilities line up: `svc:admin:apikey:read` implies
 * `read:ApiKey`, which is exactly what the read routes' `@CanRead('ApiKey')`
 * demands — so a `:read`-only token clears the scope gate AND the CASL gate.
 * (Where they do NOT line up, the scope must stay orphaned rather than become
 * a credential that authenticates, passes the scope check and is then 403'd.)
 */

/**
 * the subject INSTANCE the seeded `ApiKey` conditions
 * compare against. Two rules reach this controller: `manage:ApiKey
 * { tenantId }` (tenant admins) and `api-key-own-manage`'s
 * `[read, update, delete, list]:ApiKey { tenantId, userId }` (every key
 * creator).
 *
 * SHADOW ONLY — corrected by. listed `read`/`update`/
 * `delete:ApiKey` in `CASL_ENFORCED_PAIRS`; e2e proved the pairs
 * could never fire, and removed them. Both facts are properties of
 * THIS resolver, so record them here:
 *
 * 1. It loads the row through `IApiKeyService.fetchById`, which runs
 *    `assertKeyAccess` and throws 404 for a key the caller does not own. On
 *    exactly the request an enforced pair would exist to deny, this resolver
 *    THROWS, `runCaslInstanceChecks` swallows it on its fail-open path, and
 *    no denial is ever produced. It is therefore NOT enforce-grade, and it is
 *    deliberately not declared as such — `auditCaslEnforcePairReachability`
 *    would refuse to boot the gateway if the pair were re-listed against it.
 * 2. Fixing (1) by reading the row without the assertion would make the guard
 *    pre-empt `assertKeyAccess`'s deliberate **404** with a 403, leaking that
 *    a peer's key exists. The ownership boundary belongs to the service layer,
 *    which is the layer that can express 404. See `policy.engine.ts`
 * finding 3.
 *
 * What it still buys: `casl_shadow_divergence_total` observations on a real
 * route, at the cost of one extra query on an admin surface.
 *
 * `subject: 'ApiKey'` is declared so the instance is only ever compared
 * against `ApiKey` permissions — closed the gap where one route-level
 * resolver was applied to every required permission on the route.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request shape varies by HTTP adapter, matching SubjectInstanceResolver's own signature.
const resolveApiKeyInstance = async (request: any, ctx: SubjectResolverContext): Promise<Record<string, unknown> | undefined> => {
  const id = request?.params?.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const key = await ctx.get<IApiKeyService>(IApiKeyService).fetchById(id);
  if (!key) return undefined;
  return { tenantId: key.tenantId, userId: key.userId };
};

@ApiBearerAuth()
@ApiTags('admin-api-keys')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:apikey:write')
@Controller('admin/api-keys')
@CanManage('ApiKey')
export class ApiKeyController {
  constructor(
    @Inject(IApiKeyService)
    private readonly apiKeyService: IApiKeyService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get('scopes')
  @ApiOperation({
    summary: 'List available API key scopes',
    description: 'Returns the grantable scope catalogue, grouped by category, plus the three scope presets the create-key dialog offers.',
  })
  @ApiResponse({ status: 200, description: 'Available scopes grouped by category, plus the scope presets', type: ApiKeyScopesCatalogResponse })
  @CanRead('ApiKey')
  @RequiredSvcScopes('svc:admin:apikey:read', 'svc:admin:apikey:write')
  getAvailableScopes(): ApiKeyScopesCatalogResponse {
    return getApiKeyScopesCatalog();
  }

  /**
   * AUTH-NOTE: `@CanCreate('ApiKey')` UNDERSTATES the real gate. `ApiKeyService`
   * additionally enforces a privilege CEILING on the requested `scopes`
   * (`assertScopeCeiling`): every scope's implied CASL ability must be one the
   * CALLING principal already holds, so a tenant admin cannot mint a key
   * carrying `admin:*` or the bare `'*'`. It fails CLOSED when the caller's
   * compiled ability is unavailable — notably on the API-key-authenticated
   * minting path, where `UnifiedAuthGuard` deliberately never publishes the
   * ability to CLS. A refusal is a 403 (privilege boundary), NOT the
   * cross-tenant 404-over-403 posture this controller's by-id routes use.
   */
  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 201, description: 'API key created. Raw key returned only once.', type: CreateApiKeyResponse })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @CanCreate('ApiKey')
  async create(@Body() request: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    const result = await this.apiKeyService.create(request);
    return {
      apiKey: ApiKeyDtoMapper.ToResponse(result.apiKey),
      rawKey: result.rawKey,
    };
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @CanRead('ApiKey')
  @RequiredSvcScopes('svc:admin:apikey:read', 'svc:admin:apikey:write')
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedApiKeyResponse> {
    const tenantId = this.clsService.get('tenantId');
    const result = tenantId
      ? await this.apiKeyService.fetchAllByTenantId({
          ...queryParams,
          tenantId,
          sort: queryParams.sort || 'updatedAt:desc',
        })
      : await this.apiKeyService.fetchAll({
          ...queryParams,
          sort: queryParams.sort || 'updatedAt:desc',
        });
    return ApiKeyDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanRead('ApiKey')
  @RequiredSvcScopes('svc:admin:apikey:read', 'svc:admin:apikey:write')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async fetchById(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.fetchById(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  /**
   * AUTH-NOTE: `@CanUpdate('ApiKey')` UNDERSTATES the real gate — the same
   * scope ceiling as `create` above, applied to the WIDENING DELTA only. A
   * PATCH is refused (403) when it ADDS a scope whose implied ability the
   * caller does not hold; renames and narrowing PATCHes are not gated, and a
   * PATCH that omits `scopes` is not checked at all.
   */
  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async update(@Param('id') id: string, @Body() request: UpdateApiKeyRequest): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.update(id, request);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanDelete('ApiKey')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async delete(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.deleteById(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
    path: ':id/revoke',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async revoke(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.revokeKey(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  // Rotate: mint a NEW key inheriting the old key's config,
  // link old→new, and (per the pre-existing service) keep BOTH valid for a 24h
  // grace window (`rotationExpiresAt`) rather than invalidating immediately.
  // The new raw key is returned exactly ONCE (same contract as create).
  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
    path: ':id/rotate',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({
    status: 201,
    description: 'API key rotated. New raw key returned only once; old key stays valid for a 24h grace window.',
    type: CreateApiKeyResponse,
  })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async rotate(@Param('id') id: string): Promise<CreateApiKeyResponse> {
    const result = await this.apiKeyService.rotateKey(id);
    return {
      apiKey: ApiKeyDtoMapper.ToResponse(result.newApiKey),
      rawKey: result.newRawKey,
    };
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    path: ':id/usage',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 200, description: 'API key usage statistics', type: ApiKeyUsageResponse })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanRead('ApiKey')
  @RequiredSvcScopes('svc:admin:apikey:read', 'svc:admin:apikey:write')
  @ResolveSubjectInstance(resolveApiKeyInstance, { subject: 'ApiKey' })
  async getUsage(@Param('id') id: string): Promise<ApiKeyUsageResponse> {
    const apiKey = await this.apiKeyService.fetchById(id);
    const mapped = ApiKeyDtoMapper.ToResponse(apiKey);
    return {
      totalCalls: mapped.usageCount ?? 0,
      lastUsedAt: mapped.lastUsedAt ?? null,
      rateLimit: mapped.rateLimit ?? 0,
    };
  }
}
