import {
  CreateTenantAllowedOriginRequest,
  ITenantAllowedOriginService,
  TenantAllowedOriginResponse,
  UpdateTenantAllowedOriginRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { CanManage, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/** FR-4 / TASK-641 §3.2 option A — the one fact a tenant admin needs, nothing else. */
export class AllowedOriginEnforcementPostureResponse {
  @ApiProperty({
    description:
      'Whether origin enforcement (the CORS allow-list gate) is currently ON, platform-wide. Backed by the ' +
      '`origin.enforcementEnabled` global-kv setting via `isOriginEnforcementEnabled()` — never per-tenant, ' +
      'per-row state.',
  })
  enforcementEnabled!: boolean;
}

/**
 * TASK-610 admin CRUD surface for the CORS control-plane allow-list —
 * `TenantAllowedOrigin` rows — mounted at `/admin/allowed-origins` (global
 * prefix → `/api/v1/admin/allowed-origins`). Read/write goes through
 * `ITenantAllowedOriginService` (`@arcaai/applications`), which is
 * tenant-scoped off CLS (no `?tenantId=` query — mirrors
 * `TenantStorageConfigAdminController#listConfigs`).
 *
 * AUTH-NOTE (TASK-641): governance is NO LONGER global-admin-only on every
 * route — that blanket `assertGlobalAdmin()` imperative gate is gone. The
 * class-level `@CanManage('TenantAllowedOrigin')` now actually gates:
 * `tenant-full-access` (seed `01-policy.ts`) grants `manage:TenantAllowedOrigin`
 * scoped to `conditions.tenantId`, so a `TENANT_ADMIN` reaches this surface for
 * THEIR OWN tenant's rows, and `GLOBAL_ADMIN` reaches it unchanged via
 * `manage:all` (FR-1, FR-5). `tenantId` itself is never a route/body
 * parameter — every handler is scoped by whatever `ITenantAllowedOriginService`
 * reads off CLS, so a caller cannot forge, read, or steal another tenant's
 * row (see the service's `findOwnedOrThrow` — cross-tenant ids answer 404,
 * never 403: the 404-over-403 posture, unaffected by this change).
 *
 * Reading ONLY this class decorator therefore UNDERSTATES the real gate on
 * `create`/`update`: two narrower privilege boundaries still exist, and are
 * enforced IMPERATIVELY one layer down in `TenantAllowedOriginService`, NOT
 * duplicated here — `05-nestjs-api.md` §"Imperative Privilege Checks", and
 * TASK-610 §5.2 lesson 3 ("copying a rule into two places re-creates the
 * defect it was meant to fix"):
 *
 *   - A wildcard/pattern origin (anything `isOriginPattern()` accepts, incl.
 *     the bare `*`) is GLOBAL_ADMIN-only on BOTH `create` and `update` — a
 *     tenant admin cannot register one, and cannot escalate an existing
 *     exact row into one via PATCH (the `update` escalation path).
 *   - A SYSTEM-tenant row stays GLOBAL_ADMIN-only regardless of caller role.
 *
 * Both are 403 privilege boundaries — never the 404-over-403 cross-tenant
 * posture described above.
 *
 * `getPosture()` (FR-4) is deliberately outside all of this: it reports a
 * single platform-wide boolean (`isOriginEnforcementEnabled()`, TASK-610's
 * frozen accessor — not re-derived here), not a `TenantAllowedOrigin` row,
 * so it carries no per-tenant scoping of its own.
 */
@ApiBearerAuth()
@ApiTags('admin-allowed-origins')
@Controller('admin/allowed-origins')
@CanManage('TenantAllowedOrigin')
export class TenantAllowedOriginController {
  constructor(
    @Inject(ITenantAllowedOriginService)
    private readonly tenantAllowedOriginService: ITenantAllowedOriginService,
  ) {}

  // Declared BEFORE the `:id` route below so Nest's router matches the
  // literal `posture` segment first — a dynamic `:id` handler registered
  // earlier would otherwise swallow `GET /admin/allowed-origins/posture` as
  // `id === 'posture'`.
  @Get('posture')
  @ApiOperation({ summary: 'Report whether origin enforcement is currently ON, platform-wide (FR-4).' })
  @ApiResponse({ status: 200, type: AllowedOriginEnforcementPostureResponse })
  getPosture(): AllowedOriginEnforcementPostureResponse {
    return { enforcementEnabled: isOriginEnforcementEnabled() };
  }

  @Get()
  @ApiOperation({ summary: "List the caller tenant's allowed-origin rows" })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse, isArray: true })
  async getAll(): Promise<TenantAllowedOriginResponse[]> {
    return this.tenantAllowedOriginService.getAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one allowed-origin row by id' })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  async getById(@Param('id') id: string): Promise<TenantAllowedOriginResponse> {
    return this.tenantAllowedOriginService.getById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a new allowed origin',
    description:
      'The raw `origin` is normalized server-side (`normalizeOrigin()`) before persistence and uniqueness ' +
      'checking — the normalized form, not the raw input, is what gets stored. A wildcard/pattern origin, or a ' +
      'write to a SYSTEM-tenant row, is refused with 403 unless the caller is a global administrator (enforced ' +
      'in `TenantAllowedOriginService`, not here — see the class AUTH-NOTE).',
  })
  @ApiResponse({ status: 201, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 400, description: 'Malformed or disallowed origin.' })
  @ApiResponse({ status: 403, description: 'A non-global caller attempted a wildcard/pattern origin or a SYSTEM-tenant row.' })
  @ApiResponse({ status: 409, description: 'The normalized origin is already registered.' })
  async create(@Body() request: CreateTenantAllowedOriginRequest): Promise<TenantAllowedOriginResponse> {
    return this.tenantAllowedOriginService.create(request);
  }

  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update an allowed-origin row under optimistic concurrency',
    description:
      'Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) is REQUIRED, and the server runs a ' +
      "Compare-And-Set against the row's `_version`. When the header is present, its value overrides the " +
      'body-field `expectedVersion`. On version drift the response is `412 Precondition Failed`; a missing ' +
      'header is `428 Precondition Required`. `origin` (when present in the body) is re-normalized; escalating ' +
      "an exact row's `origin` into a wildcard/pattern is refused with 403 unless the caller is a global " +
      'administrator (enforced in `TenantAllowedOriginService`, not here — see the class AUTH-NOTE).',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 403, description: 'A non-global caller attempted to escalate the origin into a wildcard/pattern.' })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  @ApiResponse({ status: 409, description: 'The re-normalized origin collides with another row.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateTenantAllowedOriginRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantAllowedOriginResponse> {
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
  @ApiOperation({ summary: 'Soft-delete an allowed-origin row' })
  @ApiParam({ name: 'id', description: 'TenantAllowedOrigin ID', type: String })
  @ApiResponse({ status: 200, type: TenantAllowedOriginResponse })
  @ApiResponse({ status: 404, description: 'Row not found (or owned by another tenant).' })
  async deleteById(@Param('id') id: string): Promise<TenantAllowedOriginResponse> {
    return this.tenantAllowedOriginService.deleteById(id);
  }
}
