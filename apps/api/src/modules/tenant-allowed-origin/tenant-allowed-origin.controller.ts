import {
  CreateTenantAllowedOriginRequest,
  IActiveUserContext,
  ITenantAllowedOriginService,
  isSuperAdmin,
  TenantAllowedOriginResponse,
  UpdateTenantAllowedOriginRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * TASK-610 admin CRUD surface for the CORS control-plane allow-list —
 * `TenantAllowedOrigin` rows — mounted at `/admin/allowed-origins` (global
 * prefix → `/api/v1/admin/allowed-origins`). Read/write goes through
 * `ITenantAllowedOriginService` (`@arcaai/applications`), which is
 * tenant-scoped off CLS (no `?tenantId=` query — mirrors
 * `TenantStorageConfigAdminController#listConfigs`).
 *
 * AUTH-NOTE: Governance for this ticket is GLOBAL-ADMIN-ONLY on every route
 * (owner decision — README §Owner decisions, plan §3.4 item 6). This is the
 * "global-admin-only action on a tenant-manageable resource" pattern from
 * `05-nestjs-api.md` §Imperative Privilege Checks: the permission decorators
 * express `action + subject`, and there is no "global admin" *subject*, so
 * `@CanManage('TenantAllowedOrigin')` cannot by itself express "global admins
 * only" — it only satisfies the boot-time deny-by-default route-permission
 * audit (`admin-route-permission-audit.ts`), which requires `@Public()` or a
 * concrete permission decorator on every `/admin/*` route.
 *
 * The REAL gate is `assertGlobalAdmin()`, called imperatively at the top of
 * every handler below. `ITenantAllowedOriginService` deliberately does NOT
 * enforce this itself (see its class doc) — the controller is the single
 * enforcement point for this ticket. Do not widen or remove either check
 * without re-reading both docs first. This is a 403 privilege boundary, not
 * the 404-over-403 cross-tenant posture: `getById`/`update`/`deleteById`
 * still answer 404 (via the service) for a cross-tenant id once past this gate.
 *
 * RBAC note: no seeded policy currently grants `manage:TenantAllowedOrigin`
 * to any tenant-scoped role (verified against
 * `packages/database/src/prisma/db_main/seed/01-policy.ts`) — only the
 * GLOBAL_ADMIN system policy's `{ action: 'manage', subject: 'all' }`
 * wildcard (`seed/01-policy.ts:54`) reaches this subject, the same shape
 * already documented for `TenantIdentityProvider` (`seed/01-policy.ts:187-189`).
 * `assertGlobalAdmin()` is what keeps that true if a future ticket ever adds
 * such a grant by mistake.
 */
@ApiBearerAuth()
@ApiTags('admin-allowed-origins')
@Controller('admin/allowed-origins')
@CanManage('TenantAllowedOrigin')
export class TenantAllowedOriginController {
  constructor(
    @Inject(ITenantAllowedOriginService)
    private readonly tenantAllowedOriginService: ITenantAllowedOriginService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the caller tenant's allowed-origin rows — GLOBAL_ADMIN only" })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse, isArray: true })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  async getAll(): Promise<TenantAllowedOriginResponse[]> {
    this.assertGlobalAdmin();
    return this.tenantAllowedOriginService.getAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one allowed-origin row by id — GLOBAL_ADMIN only' })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  async getById(@Param('id') id: string): Promise<TenantAllowedOriginResponse> {
    this.assertGlobalAdmin();
    return this.tenantAllowedOriginService.getById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a new allowed origin — GLOBAL_ADMIN only',
    description:
      'The raw `origin` is normalized server-side (`normalizeOrigin()`) before persistence and uniqueness ' +
      'checking — the normalized form, not the raw input, is what gets stored.',
  })
  @ApiResponse({ status: 201, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 400, description: 'Malformed or disallowed origin.' })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @ApiResponse({ status: 409, description: 'The normalized origin is already registered.' })
  async create(@Body() request: CreateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse> {
    this.assertGlobalAdmin();
    return this.tenantAllowedOriginService.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update an allowed-origin row under optimistic concurrency — GLOBAL_ADMIN only',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`. `origin` (when present in the body) is re-normalized.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  @ApiResponse({ status: 409, description: 'The re-normalized origin collides with another row.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateTenantAllowedOriginRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantAllowedOriginResponse> {
    this.assertGlobalAdmin();
    // Header takes precedence over the body when both are present — the
    // house precedence (`department.controller.ts#update`). On a
    // `@RequiresIfMatch()` route the header is guaranteed present at
    // runtime (missing → 428 before the handler runs); the fallback only
    // fires for direct unit-test / off-route calls.
    const effectiveRequest: UpdateTenantAllowedOriginRequest =
      expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.tenantAllowedOriginService.update(id, effectiveRequest);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an allowed-origin row — GLOBAL_ADMIN only' })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  async deleteById(@Param('id') id: string): Promise<TenantAllowedOriginResponse> {
    this.assertGlobalAdmin();
    return this.tenantAllowedOriginService.deleteById(id);
  }

  /**
   * The load-bearing global-admin gate (see the class AUTH-NOTE above).
   * Throws before the service is ever invoked.
   */
  private assertGlobalAdmin(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Managing tenant allowed origins requires platform (global-admin) privileges.');
    }
  }
}
