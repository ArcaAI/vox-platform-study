import {
  ITenantService,
  PaginatedQuery,
  TenantResponse,
  CreateTenantRequest,
  PaginatedTenantResponse,
  UpdateTenantRequest,
  TenantDtoMapper,
  HttpMethod,
  PaginatedTenantConfigResponse,
  TenantConfigDtoMapper,
  UpdateTenantConfigRequest,
  SetTenantTagsRequest,
  IActiveUserContext,
  isSuperAdmin,
  FetchResponse,
} from '@arcaai/applications';
import { Controller, Body, Param, Get, Post, Put, HttpCode, Inject, Query, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanAny, CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { assertTenantInScope as assertTenantScope } from '../../shared/tenant-scope';

// Canonical RFC 4122 8-4-4-4-12 shape (any version, incl. the
// uuidv7 tenant ids the platform mints). Lets the config scope guard decide
// up-front when a dual `:identifier` is a tenant UUID vs a code-name.
const TENANT_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// `@RequiresIfMatch()` route marker +
// `@ExpectedVersion()` param decorator. The route guard fires 428 when
// the header is missing; the param decorator returns the parsed version
// when present (or `undefined` when this route is NOT marked, leaving
// the body-field as the service's source of truth).
import { RequiresIfMatch, ExpectedVersion } from '../../decorators';
import { TenantUsageResponse } from './dto';

/**
 * Class-level posture is `manage:Tenant` OR
 * `update:Tenant`, so a TENANT_ADMIN (who has tenant-scoped `update:Tenant`
 * via `tenant-full-access`) can reach the read/update/config routes for their
 * own tenant, while SUPER_ADMIN (`manage:all`) keeps full cross-tenant access.
 * Tenant `create`/`delete` are privilege-escalation paths and are pinned to
 * `manage:Tenant` at the method level below (SUPER_ADMIN-only). Per-row reads
 * still inline-assert tenant scope via `assertTenantInScope`.
 */
@ApiBearerAuth()
@ApiTags('admin-tenants')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:tenant:write')
@Controller('admin/tenants')
@CanAny(['manage', 'Tenant'], ['update', 'Tenant'])
export class TenantController {
  constructor(
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  /**
   * The class-level
   * `@CanAny(['manage','Tenant'],['update','Tenant'])` authorises any caller
   * with `manage:Tenant` or tenant-scoped `update:Tenant` to reach the per-row
   * routes, but the underlying CASL policy is `tenantId: ${user.tenantId}`. The
   * `:id` path param breaks that condition silently — so each per-row
   * handler must inline-assert the tenant scope itself. SUPER_ADMIN
   * bypasses (cross-tenant ops are an operator's job).
   */
  private assertTenantInScope(targetTenantId: string): void {
    assertTenantScope(this.cls.get('user'), targetTenantId);
  }

  /**
   * Scope guard for the tenant-config routes, which take a
   * dual `:identifier` (tenant UUID OR code-name). A non-super-admin may only
   * address their own tenant. We can decide this up-front ONLY for a UUID
   * identifier; a code-name is deferred to the service's own
   * no-existence-leak guard (it resolves code-name → tenant, then 404s
   * cross-tenant). Throws `NotFoundException` (NOT `ForbiddenException`) so the
   * controller does NOT weaken that no-existence-leak posture for config rows.
   * SUPER_ADMIN bypasses (cross-tenant operator flows + console tenant picker).
   */
  private assertConfigInScope(identifier: string): void {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) return;
    const callerTenantId = user?.tenantId;
    if (!callerTenantId) {
      throw new NotFoundException('Resource not found');
    }
    if (TENANT_UUID_PATTERN.test(identifier) && identifier !== callerTenantId) {
      throw new NotFoundException('Resource not found');
    }
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  // Creating tenants is SUPER_ADMIN-only. Method-level
  // metadata overrides the class `@CanAny(...)`, so a TENANT_ADMIN (who lacks
  // `manage:Tenant`) is refused here even though it can reach read/update.
  @CanManage('Tenant')
  async create(@Body() request: CreateTenantRequest): Promise<TenantResponse> {
    const result = await this.tenantService.create(request);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    // `Tenant` rows are NOT covered by the tenantScopeFilter Prisma
    // extension, and the class-level `@CanAny(['manage','Tenant'],['update','Tenant'])`
    // admits any TENANT_ADMIN (their CASL policy is `tenantId: ${user.tenantId}`). Without
    // this guard a tenant admin could enumerate every tenant on the platform.
    // Non-super-admins are restricted to their own tenant; SUPER_ADMIN keeps the
    // full cross-tenant listing (admin/operator surfaces). Mirrors the write-path
    // posture on `update`/`delete`.
    const user = this.cls.get('user');
    if (!isSuperAdmin(user)) {
      if (!user?.tenantId) {
        throw new ForbiddenException('You do not have access to list tenants');
      }
      const own = await this.tenantService.fetchById(user.tenantId);
      return TenantDtoMapper.ToPaginatedResponse(new FetchResponse({ data: [own], count: 1, page: 1, limit: 1 }));
    }

    const result = await this.tenantService.fetchAll({
      ...queryParams,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: 'user/:userId',
    multi: true,
    by: ['createdByUserId'],
  })
  @ApiParam({ name: 'userId', description: 'User ID', type: String })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async fetchByUserId(@Param('userId') userId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    const result = await this.tenantService.fetchAllCreatedByUser({
      ...queryParams,
      userId,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant usage statistics' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant usage statistics', type: TenantUsageResponse })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async getUsage(@Param('id') id: string): Promise<TenantUsageResponse> {
    this.assertTenantInScope(id);
    return this.tenantService.getUsageStats(id);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async fetchById(@Param('id') id: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    // The route parameter is `:codeName`, NOT `:code-name`. path-to-regexp
    // parameter names are `[A-Za-z0-9_]+`, so a hyphen TERMINATES the name:
    // `:code-name` binds a parameter called `code` followed by the literal text
    // `-name`. That made this route unreachable at the URL it advertises (the
    // literal suffix was required) and, on a URL that did match, left
    // `@Param('code-name')` naming a parameter that cannot exist — so the
    // service was called with `undefined`. Swagger rendered the truth the whole
    // time, as `/admin/tenants/code-name/{code}-name`.
    path: 'code-name/:codeName',
    // Description prose only — `by` is joined into the generated Swagger summary
    // by `getDescription`, and is not a parameter binding. "code-name" is the
    // right human phrasing for the concept, so it deliberately does not track
    // the parameter's identifier.
    by: ['code-name'],
  })
  @ApiParam({ name: 'codeName', description: 'Tenant code name', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async fetchByCodeName(@Param('codeName') codeName: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchByCodeName(codeName);
    // Guard runs AFTER the lookup because code-name is not the same as the
    // tenant's UUID — we need the loaded row's `id` to compare against the
    // caller's tenant.
    this.assertTenantInScope(result.id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update tenant',
    description:
      'Updates one tenant row. Optimistic concurrency is enforced: ' +
      'the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a Compare-And-Set ' +
      "against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; ' +
      'missing header is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'RFC 7232 strong validator carrying the version the client read (e.g. `"7"`). ' +
      "The server CAS'es against this value; if `_version` has drifted, a `412 " +
      'Precondition Failed` is returned with the current version in the response body.',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiResponse({
    status: 403,
    description:
      'Either the row is a RESERVED tenant (SYSTEM / Global — no PATCH is accepted), or the body changes `plan` and the caller is not a platform administrator.',
  })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  // AUTH-NOTE: the class decorator UNDERSTATES this route's gate — TenantService.update
  // adds TWO imperative checks the `action + subject` pairs cannot express (TASK-986):
  //   1. Reserved rows (SYSTEM `00000000-…`, Global `50000000-…`) refuse EVERY PATCH
  //      (owner ruling D-5). 403, not the 404-over-403 cross-tenant posture: both ids
  //      are declared constants, so there is no existence to hide.
  //   2. `plan` is a SUPER_ADMIN-only FIELD (owner decision D-1). The seed grants a
  //      tenant admin `update:Tenant` on its OWN id, and there is no super-admin CASL
  //      subject, so "every field but this one" cannot be declared. The service resolves
  //      EXISTENCE first (`findById`), so an unknown id is still 404 and the gate is
  //      never an existence oracle; it fires only when the request actually CHANGES the
  //      plan. Do not widen either check without reading the service.
  async update(
    @Param('id') id: string,
    @Body() request: UpdateTenantRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    // Header takes precedence over body
    // when both are present. On a `@RequiresIfMatch()` route, the param
    // decorator already fired 428 if the header would have been
    // undefined, so the fallback below is only reachable in tests /
    // off-route service-to-service traffic.
    const effectiveRequest: UpdateTenantRequest = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    const result = await this.tenantService.update(id, effectiveRequest);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  // Deleting tenants is SUPER_ADMIN-only (see create()).
  @CanManage('Tenant')
  async delete(@Param('id') id: string): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.deleteById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  // ── Tenant lifecycle transitions ────────────────────────────────────────────
  // suspend/archive/restore are privileged operator actions (like create/delete)
  // so they are pinned to `manage:Tenant` (SUPER_ADMIN). Non-OCC: these are
  // explicit admin state changes, not last-write-wins field edits. The service
  // additionally blocks the system tenant (DEF-ADM-002) on suspend/archive.

  @Post(':id/suspend')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({ summary: 'Suspend a tenant (reversible operator hold)' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant suspended', type: TenantResponse })
  @ApiResponse({ status: 403, description: 'The system tenant cannot be suspended (DEF-ADM-002)' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async suspend(@Param('id') id: string): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.suspend(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({ summary: 'Archive a tenant (recoverable cold state)' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant archived', type: TenantResponse })
  @ApiResponse({ status: 403, description: 'The system tenant cannot be archived (DEF-ADM-002)' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async archive(@Param('id') id: string): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.archive(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({ summary: 'Restore a suspended/archived tenant to ENABLED' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant restored', type: TenantResponse })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async restore(@Param('id') id: string): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.restore(id);
    return TenantDtoMapper.ToResponse(result);
  }

  // ── Tenant tags ──────────────────────────────────────────────────────────
  // Tags are a lightweight `String[]` scalar on Tenant (see ticket doc for the
  // representation decision). Read/set are tenant-scoped: a TENANT_ADMIN may
  // manage tags on their OWN tenant (class-level `update:Tenant`), SUPER_ADMIN
  // cross-tenant. `assertTenantInScope` enforces the per-row boundary.

  @Get(':id/tags')
  @ApiOperation({ summary: "Read a tenant's tags" })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant tags' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async getTags(@Param('id') id: string): Promise<{ tags: string[] }> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.fetchById(id);
    return { tags: result.tags ?? [] };
  }

  @Put(':id/tags')
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Replace a tenant's full tag set (idempotent set-semantics)",
    description:
      'Optimistic concurrency is ENFORCED: the `If-Match` header (RFC 7232) is REQUIRED and CASes against the ' +
      "tenant row's `_version`. The precondition is evaluated even when the supplied tag set is identical to the " +
      'stored one, so a stale client is told to refetch (`412`) rather than silently succeeding. A missing header ' +
      'is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the tenant version the client read (e.g. `"7"`).',
    required: true,
    example: '"7"',
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Updated tenant', type: TenantResponse })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async setTags(
    @Param('id') id: string,
    @Body() request: SetTenantTagsRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantResponse> {
    this.assertTenantInScope(id);
    const result = await this.tenantService.setTags(id, request.tags, expectedFromHeader);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    path: 'configs/:identifier',
    by: ['identifier'],
    multi: true,
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  @CanAny(['manage', 'Tenant'], ['update', 'Tenant'], ['read', 'AdminTenantDirectory'])
  @RequiredSvcScopes('svc:admin:tenant:read', 'svc:admin:tenant:write')
  async fetchTenantConfigs(@Param('identifier') identifier: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantConfigResponse> {
    this.assertConfigInScope(identifier);
    const result = await this.tenantService.fetchTenantConfigs({
      ...queryParams,
      tenantId: identifier,
      codeName: identifier,
    });
    return TenantConfigDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    method: HttpMethod.PATCH,
    path: '/configs/:identifier',
    by: ['identifier'],
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - invalid config data' })
  async updateTenantConfigs(
    @Param('identifier') identifier: string,
    @Body() configs: UpdateTenantConfigRequest[],
  ): Promise<PaginatedTenantConfigResponse> {
    this.assertConfigInScope(identifier);
    // Explicit updatable-key allow-list. The global
    // ValidationPipe does NOT whitelist array-body elements (see
    // `my-tenant.controller.ts`), so the raw body could smuggle extra keys
    // (`locked`, `tenantId`, `key`, …) to the service. Forward ONLY the
    // mutable fields — id (target row), value, description and the OCC token.
    const sanitizedConfigs = (configs ?? []).map(({ id, value, description, expectedVersion }) => ({
      id,
      value,
      description,
      expectedVersion,
    })) as UpdateTenantConfigRequest[];
    const result = await this.tenantService.updateTenantConfigs(identifier, sanitizedConfigs);
    return TenantConfigDtoMapper.ToPaginatedResponse(result);
  }
}
