import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { CoreDatabaseService, McpServerFactory, McpServerRepository, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IMcpServerAdminService } from './IMcpServerAdminService';
import { McpServerDtoMapper } from './mcp-server.dto.mapper';
import { CreateMcpServerRequest, McpServerListResponse, McpServerResponse, UpdateMcpServerRequest } from './dto';

/**
 * MCP external-tools registry admin service.
 *
 * Registry rows are SYSTEM-owned initially (the shared platform registry).
 * Reads (list/get) are available to tenant admins over the SYSTEM-shared read
 * model (backs the console "Tools & MCP" screen); a cross-tenant read
 * simply misses → 404. WRITES are SUPER_ADMIN-ONLY — a tenant-admin write gets
 * a `ForbiddenException` (403), the guardrail.* privilege-boundary precedent
 * (deliberately NOT the 404-over-403 tenancy posture: it is a privilege rule on
 * a registry the caller can already read).
 *
 * SECURITY: no secret material ever enters the DB or a response. `authRef` is a
 * Vault PATH only (the DTO validates it path-like); the credential lives in
 * Vault and is never echoed.
 */
@Injectable()
export class McpServerAdminService extends BaseService implements IMcpServerAdminService {
  constructor(
    private readonly mcpServerRepository: McpServerRepository,
    // The UNSCOPED base client backs the super-admin cross-tenant lane
    // (mirrors AiTaskDefaultService / HarnessPolicyService).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.McpServer);
  }

  async list(tenantId?: string): Promise<McpServerListResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    // Cross-tenant lane: scope explicitly to [target, SYSTEM]. Otherwise let the
    // extended client widen the SYSTEM-shared read to [caller, SYSTEM].
    const rows = tx
      ? await this.mcpServerRepository.listEnabled([scopedTenantId, SYSTEM_TENANT_ID], tx)
      : await this.mcpServerRepository.listEnabled();
    return McpServerDtoMapper.toListResponse(rows);
  }

  async get(id: string, tenantId?: string): Promise<McpServerResponse> {
    const scopedTenantId = this.resolveScopedTenantId(tenantId);
    const tx = this.crossTenantLane(scopedTenantId);
    const row = await this.mcpServerRepository.findEnabledById(id, tx);
    if (!row) {
      // 404 for both an absent id and a cross-tenant row (no existence leak).
      throw new NotFoundException('MCP server not found');
    }
    return McpServerDtoMapper.toResponse(row);
  }

  async create(dto: CreateMcpServerRequest, tenantId?: string): Promise<McpServerResponse> {
    this.assertSuperAdmin();
    // Registry rows are SYSTEM-owned initially; a super admin may still target
    // a specific tenant explicitly, but the default write target is SYSTEM.
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    const tx = this.crossTenantLane(scopedTenantId);

    const existing = await this.mcpServerRepository.findByTenantAndName(scopedTenantId, dto.name, tx);
    if (existing) {
      throw new ArgumentInvalidException(`An MCP server named '${dto.name}' already exists for this tenant.`);
    }

    const entity = McpServerFactory.CreateMcpServer({
      tenantId: scopedTenantId,
      name: dto.name,
      description: dto.description ?? null,
      baseUrl: dto.baseUrl,
      transport: dto.transport,
      authRef: dto.authRef ?? null,
      toolAllowlist: dto.toolAllowlist ?? null,
      phiBoundary: dto.phiBoundary,
      enabled: dto.enabled ?? false,
      createdBy: this.requestUserId ?? undefined,
    });
    entity.validate();
    const saved = await this.mcpServerRepository.create(entity, tx);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { name: saved.name, phiBoundary: saved.phiBoundary, enabled: saved.enabled },
    });
    return McpServerDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateMcpServerRequest, expectedVersion: number | undefined, tenantId?: string): Promise<McpServerResponse> {
    this.assertSuperAdmin();
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    const tx = this.crossTenantLane(scopedTenantId);

    const existing = await this.mcpServerRepository.findEnabledById(id, tx);
    if (!existing) {
      throw new NotFoundException('MCP server not found');
    }

    const changes: Record<string, unknown> = {};
    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.baseUrl !== undefined) changes.baseUrl = dto.baseUrl;
    if (dto.transport !== undefined) changes.transport = dto.transport;
    if (dto.authRef !== undefined) changes.authRef = dto.authRef;
    if (dto.toolAllowlist !== undefined) changes.toolAllowlist = dto.toolAllowlist;
    if (dto.phiBoundary !== undefined) changes.phiBoundary = dto.phiBoundary;
    if (dto.enabled !== undefined) changes.enabled = dto.enabled;

    await this.updateEntity(existing, changes);
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(existing, expectedVersion);
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write.');
    }
    existing.validate();
    if (expectedVersion === undefined) {
      throw new OptimisticConcurrencyException('McpServer', existing.id, { expectedVersion, currentVersion: existing.version });
    }
    const previousVersion = existing.version;
    const updated = await this.mcpServerRepository.updateWithVersion(existing.id, existing, expectedVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { name: updated.name, previousVersion, newVersion: updated.version },
    });
    return McpServerDtoMapper.toResponse(updated);
  }

  async remove(id: string, expectedVersion: number | undefined, tenantId?: string): Promise<McpServerResponse> {
    this.assertSuperAdmin();
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    const tx = this.crossTenantLane(scopedTenantId);

    const existing = await this.mcpServerRepository.findEnabledById(id, tx);
    if (!existing) {
      throw new NotFoundException('MCP server not found');
    }
    if (expectedVersion === undefined) {
      throw new OptimisticConcurrencyException('McpServer', existing.id, { expectedVersion, currentVersion: existing.version });
    }
    // Soft-delete via the change-tracked entity.delete() + CAS so the write
    // routes through the same (cross-tenant base-client) lane and OCC token.
    const previousVersion = existing.version;
    existing.delete(this.requestUserId ?? undefined);
    const deleted = await this.mcpServerRepository.updateWithVersion(existing.id, existing, expectedVersion, tx);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { name: deleted.name, previousVersion, newVersion: deleted.version },
    });
    return McpServerDtoMapper.toResponse(deleted);
  }

  // ────────────────────────────── internals ──────────────────────────────

  /** Registry WRITES are super-admin only — a privilege boundary (403), not a 404 probe. */
  private assertSuperAdmin(): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('The MCP server registry is managed by super administrators only.');
    }
  }

  /**
   * Super-admin cross-tenant persistence lane (mirrors AiTaskDefaultService):
   * when the resolved target differs from the CLS working tenant AND the caller
   * is a super admin, route the read/write through the UNSCOPED base client so
   * the SYSTEM-owned registry rows are addressed by their explicit tenant filter
   * (the extended client would otherwise inject the working tenant and miss).
   */
  private crossTenantLane(targetTenantId: string): CoreDatabaseService['baseClient'] | undefined {
    if (targetTenantId !== this.tenantId && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }

  /** Explicit tenant target (super-admin `?tenantId=`) over the CLS tenant. */
  private resolveScopedTenantId(tenantId?: string): string {
    const scoped = tenantId ?? this.tenantId;
    if (!scoped) {
      // A super admin with no working tenant reads the SYSTEM registry.
      if (isSuperAdmin(this.requestUser)) return SYSTEM_TENANT_ID;
      throw new BadRequestException('Tenant ID is required');
    }
    return scoped;
  }
}
