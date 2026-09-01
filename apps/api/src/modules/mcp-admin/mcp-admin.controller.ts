import {
  CreateMcpServerRequest,
  IActiveUserContext,
  IMcpServerAdminService,
  McpServerListResponse,
  McpServerResponse,
  UpdateMcpServerRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, CanManage, CanRead, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { resolveScopedTenantIdOptional } from '../../shared/tenant-scope';

/**
 * McpAdminController — the admin surface for the MCP
 * external-tools registry, mounted at `/admin/mcp-servers` (global prefix →
 * `/api/v1/admin/mcp-servers`). Mirrors `AiTaskDefaultAdminController`
 * (`If-Match` OCC, `resolveScoped*` tenant scoping).
 *
 * AUTHORIZATION: gated by the registry's OWN `McpServer` subject.
 * It previously borrowed `HarnessPolicy` — that subject now means
 * "harness policy", nothing else, so a grant to one no longer silently confers
 * the other. `McpServer` already exists in the audit `ResourceType` enum, so the
 * swap needed no migration; the seeded roles gained explicit `manage:McpServer`
 * grants in the same change, and CUSTOM (tenant-authored) policies that reached
 * this registry via `manage:HarnessPolicy` must add the new grant.
 *
 * Reads (list/get) back the console "Tools & MCP" screen — the caller's own
 * tenant rows plus the SYSTEM-shared registry. Cross-tenant reads are 404.
 *
 * AUTH-NOTE: SYSTEM-vs-tenant-owned SPLIT GATE — the decorators UNDERSTATE the
 * real rule, which `McpServerAdminService` enforces imperatively. Per OWNER
 * DECISION OD-7 (2026-09-01) a tenant admin holding `manage:McpServer` MAY
 * create, update and delete connectors **owned by its own tenant**; a write
 * aimed at the SYSTEM (`00000000-…`) shared registry stays SUPER_ADMIN-only and
 * returns 403 — a privilege boundary, and the row is readable so its existence
 * is not hidden. A row belonging to ANOTHER tenant returns 404 (404-over-403),
 * and existence is resolved BEFORE privilege so an unknown id is 404 for
 * everyone. This reverses the former "MCP writes are super-admin only" rule;
 * `.claude/rules/05-nestjs-api.md` was amended in the same change. No single
 * decorator can express "super-admin for the SYSTEM row, ability-gated for every
 * other row of the same resource" — same shape as
 * `POST admin/prompt-templates/:id/approve`.
 *
 * SECURITY: no response ever carries secret material — `authRef` is a Vault PATH
 * only (secrets flow through the Vault path, never this API). That is unchanged
 * for tenant-authored rows: a tenant admin registers a Vault path, not a token.
 */
@ApiBearerAuth()
@ApiTags('admin-mcp-servers')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:mcp-server:manage')
@Controller('admin/mcp-servers')
@Authorize()
export class McpAdminController {
  constructor(
    @Inject(IMcpServerAdminService) private readonly mcpServerService: IMcpServerAdminService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @CanRead('McpServer')
  @ApiOperation({
    summary: 'List registered MCP external-tools servers (registry read — backs the console "Tools & MCP" screen)',
    description:
      'Returns the servers visible to the caller: their own tenant rows plus the SYSTEM-shared registry. No secret ' +
      'material is surfaced (authRef is a Vault path only). Tenant admins are pinned to their own tenant; super admins ' +
      'target any tenant via `?tenantId=` (omit = SYSTEM registry).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: McpServerListResponse })
  async list(@Query('tenantId') tenantId?: string): Promise<McpServerListResponse> {
    return this.mcpServerService.list(this.resolveReadTenantId(tenantId));
  }

  @Get(':id')
  @CanRead('McpServer')
  @ApiOperation({ summary: 'Get one registered MCP server (registry read)' })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 404, description: 'Server not found for the tenant (absent or cross-tenant).' })
  async get(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<McpServerResponse> {
    return this.mcpServerService.get(id, this.resolveReadTenantId(tenantId));
  }

  @Post()
  @CanManage('McpServer')
  @ApiOperation({
    summary: 'Register a new MCP server (own tenant; the SYSTEM registry is GLOBAL-ADMIN only)',
    description:
      'A tenant admin holding `manage:McpServer` creates a connector owned by ITS OWN tenant. A super admin creates a ' +
      'SYSTEM-owned registry row by default, or targets a specific tenant via `?tenantId=`. A tenant admin aiming at the ' +
      'SYSTEM registry gets 403. `authRef` is a Vault path (no secret material). The server is dormant ' +
      '(`enabled: false`) unless explicitly enabled, and the MCP path is additionally gated by the per-tenant ' +
      '`HarnessPolicy.mcpToolsEnabled` (resolved tenant → SYSTEM; unset in both tiers → off).',
  })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Super-admin only: target tenant (default SYSTEM registry). Tenant admins are pinned to their own tenant.',
  })
  @ApiResponse({ status: 201, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — the SYSTEM MCP registry is managed by super administrators only.' })
  async create(@Body() body: CreateMcpServerRequest, @Query('tenantId') tenantId?: string): Promise<McpServerResponse> {
    return this.mcpServerService.create(body, this.resolveWriteTenantId(tenantId));
  }

  @Patch(':id')
  @CanManage('McpServer')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only)',
    description:
      'Sparse patch. `If-Match` (RFC 7232) is REQUIRED and CASes against the row `_version` (drift → 412, missing → 428). ' +
      'A tenant admin may patch its OWN tenant’s connectors; a SYSTEM-registry row is super-admin only (403). An id ' +
      'belonging to another tenant returns 404, and an unknown id returns 404 for every caller. `authRef` stays a Vault ' +
      'path — never secret material.',
  })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Super-admin only: target tenant (default SYSTEM registry). Tenant admins are pinned to their own tenant.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — the SYSTEM MCP registry is managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'Server not found for the tenant.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateMcpServerRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<McpServerResponse> {
    return this.mcpServerService.update(id, body, expectedFromHeader ?? body.expectedVersion, this.resolveWriteTenantId(tenantId));
  }

  @Delete(':id')
  @CanManage('McpServer')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Soft-delete a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only)',
    description:
      'Soft-delete (resourceStatus → DELETED). `If-Match` REQUIRED (OCC). A tenant admin may delete its OWN tenant’s ' +
      'connectors; a SYSTEM-registry row is super-admin only (403). Another tenant’s id — or an unknown id — is 404.',
  })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Super-admin only: target tenant (default SYSTEM registry). Tenant admins are pinned to their own tenant.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — the SYSTEM MCP registry is managed by super administrators only.' })
  @ApiResponse({ status: 404, description: 'Server not found for the tenant.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async remove(
    @Param('id') id: string,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('tenantId') tenantId?: string,
  ): Promise<McpServerResponse> {
    return this.mcpServerService.remove(id, expectedFromHeader, this.resolveWriteTenantId(tenantId));
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Read scope: tenant admins → own tenant; super admins → optional `?tenantId=` (undefined = SYSTEM registry, resolved by the service). */
  private resolveReadTenantId(queryTenantId?: string): string | undefined {
    return resolveScopedTenantIdOptional(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }

  /** Write scope: super admins target `?tenantId=` (undefined = SYSTEM, defaulted by the service). Tenant admins are 403'd at the service layer. */
  private resolveWriteTenantId(queryTenantId?: string): string | undefined {
    return resolveScopedTenantIdOptional(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
