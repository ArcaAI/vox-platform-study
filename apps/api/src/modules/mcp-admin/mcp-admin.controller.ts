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
import { Authorize, CanManage, CanRead, ExpectedVersion, RequiresIfMatch } from '../../decorators';
import { resolveScopedTenantIdOptional } from '../../shared/tenant-scope';

/**
 * McpAdminController (TASK-516 Phase 5) — the admin surface for the MCP
 * external-tools registry, mounted at `/admin/mcp-servers` (global prefix →
 * `/api/v1/admin/mcp-servers`). Mirrors `AiTaskDefaultAdminController`
 * (`If-Match` OCC, `resolveScoped*` tenant scoping) and reuses the
 * `HarnessPolicy` authorization subject (MCP tooling is a harness capability;
 * the agentic-admin precedent).
 *
 * Reads (list/get) back the TASK-512 console "Tools & MCP" screen — the registry
 * list/read. WRITES are GLOBAL-ADMIN-ONLY: the SERVICE throws a
 * `ForbiddenException` (403) for a tenant admin (the guardrail.* privilege
 * boundary; NOT the 404-over-403 tenancy posture). Cross-tenant reads are 404.
 *
 * SECURITY: no response ever carries secret material — `authRef` is a Vault PATH
 * only (secrets flow through the TASK-504 Vault path, never this API).
 */
@ApiBearerAuth()
@ApiTags('admin-mcp-servers')
@Controller('admin/mcp-servers')
@Authorize()
export class McpAdminController {
  constructor(
    @Inject(IMcpServerAdminService) private readonly mcpServerService: IMcpServerAdminService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get()
  @CanRead('HarnessPolicy')
  @ApiOperation({
    summary: 'List registered MCP external-tools servers (registry read — backs the console "Tools & MCP" screen)',
    description:
      'Returns the servers visible to the caller: their own tenant rows plus the SYSTEM-shared registry. No secret ' +
      'material is surfaced (authRef is a Vault path only). Tenant admins are pinned to their own tenant; global admins ' +
      'target any tenant via `?tenantId=` (omit = SYSTEM registry).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: McpServerListResponse })
  async list(@Query('tenantId') tenantId?: string): Promise<McpServerListResponse> {
    return this.mcpServerService.list(this.resolveReadTenantId(tenantId));
  }

  @Get(':id')
  @CanRead('HarnessPolicy')
  @ApiOperation({ summary: 'Get one registered MCP server (registry read)' })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 404, description: 'Server not found for the tenant (absent or cross-tenant).' })
  async get(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<McpServerResponse> {
    return this.mcpServerService.get(id, this.resolveReadTenantId(tenantId));
  }

  @Post()
  @CanManage('HarnessPolicy')
  @ApiOperation({
    summary: 'Register a new MCP server (GLOBAL-ADMIN only)',
    description:
      'Creates a SYSTEM-owned registry row by default (or a specific tenant via `?tenantId=`). `authRef` is a Vault path ' +
      '(no secret material). Global-admin only — a tenant admin gets 403. The server is dormant (`enabled: false`) unless ' +
      'explicitly enabled, and the whole MCP path is additionally gated OFF by `HarnessPolicy.mcpToolsEnabled` (null → off).',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Global-admin only: target tenant (default SYSTEM registry).' })
  @ApiResponse({ status: 201, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — the MCP registry is managed by global administrators only.' })
  async create(@Body() body: CreateMcpServerRequest, @Query('tenantId') tenantId?: string): Promise<McpServerResponse> {
    return this.mcpServerService.create(body, this.resolveWriteTenantId(tenantId));
  }

  @Patch(':id')
  @CanManage('HarnessPolicy')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a registered MCP server under optimistic concurrency (GLOBAL-ADMIN only)',
    description:
      'Sparse patch. `If-Match` (RFC 7232) is REQUIRED and CASes against the row `_version` (drift → 412, missing → 428). ' +
      'Global-admin only (403 for tenant admins). `authRef` stays a Vault path — never secret material.',
  })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Global-admin only: target tenant (default SYSTEM registry).' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — global-admin only.' })
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
  @CanManage('HarnessPolicy')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Soft-delete a registered MCP server under optimistic concurrency (GLOBAL-ADMIN only)',
    description: 'Soft-delete (resourceStatus → DELETED). `If-Match` REQUIRED (OCC). Global-admin only (403 for tenant admins).',
  })
  @ApiParam({ name: 'id', description: 'MCP server id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Global-admin only: target tenant (default SYSTEM registry).' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: McpServerResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — global-admin only.' })
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

  /** Read scope: tenant admins → own tenant; global admins → optional `?tenantId=` (undefined = SYSTEM registry, resolved by the service). */
  private resolveReadTenantId(queryTenantId?: string): string | undefined {
    return resolveScopedTenantIdOptional(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }

  /** Write scope: global admins target `?tenantId=` (undefined = SYSTEM, defaulted by the service). Tenant admins are 403'd at the service layer. */
  private resolveWriteTenantId(queryTenantId?: string): string | undefined {
    return resolveScopedTenantIdOptional(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
