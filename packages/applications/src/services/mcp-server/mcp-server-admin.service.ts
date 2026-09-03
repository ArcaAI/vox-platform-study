import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { CoreDatabaseService, McpServerFactory, McpServerRepository, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../common';
import { EgressPolicyService } from '../../common/egress';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IMcpServerAdminService } from './IMcpServerAdminService';
import { McpServerDtoMapper } from './mcp-server.dto.mapper';
import { CreateMcpServerRequest, McpServerListResponse, McpServerResponse, UpdateMcpServerRequest } from './dto';

/**
 * MCP external-tools registry admin service.
 *
 * Reads (list/get) resolve over the SYSTEM-shared read model — the caller's own
 * tenant rows PLUS the shared platform registry; a cross-tenant read simply
 * misses → 404.
 *
 * WRITES follow the SYSTEM-vs-tenant-owned SPLIT GATE (OWNER DECISION **OD-7**,
 * 2026-09-01 — tenant admins MAY configure MCP connectors; this reverses the
 * former "MCP writes are super-admin only" rule, and `05-nestjs-api.md` was
 * amended in the same change). The declarative grant already existed: seeded
 * tenant-admin roles hold `manage:McpServer` in CASL, and only the imperative
 * check here overrode it.
 *
 *   | Row the write targets | Tenant admin | Rationale |
 *   |--------------------------------|--------------|----------------------------|
 *   | SYSTEM (`00000000-…`) registry | **403** | privilege — the row is |
 *   | | | READABLE, so hiding its |
 *   | | | existence would be a lie |
 *   | Another customer tenant's row | **404** | 404-over-403 tenancy |
 *   | Its OWN tenant's row | allowed | OD-7 |
 *
 * ORDER IS LOAD-BEARING: existence is resolved BEFORE privilege, so an unknown
 * id is 404 for everyone. Gating first (as this service used to) would let a
 * caller tell "exists, not yours" (403) from "no such row" (404) and walk the
 * id space. Same shape as `PromptManagementService.assertCanApprove`.
 *
 * SECURITY: no secret material ever enters the DB or a response. `authRef` is a
 * Vault PATH only (the DTO validates it path-like); the credential lives in
 * Vault and is never echoed. That holds identically for tenant-authored rows —
 * a tenant admin registers a Vault path, never a bearer/OAuth token.
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
    // SSRF egress guard for the tenant-authored `baseUrl`. REQUIRED, not
    // `@Optional()`: an unwired graph must fail loudly at construction rather
    // than silently skip a security control.
    private readonly egressPolicy: EgressPolicyService,
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
    // The controller pins a tenant admin to its own tenant, so `tenantId` is the
    // caller's tenant for them and `?tenantId=` (or SYSTEM) for a super admin.
    // A tenant admin therefore lands on its OWN tenant by construction; the gate
    // below is what stops it aiming at the shared SYSTEM registry.
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    this.assertCanWriteTenant(scopedTenantId);
    // SSRF egress guard. Runs for EVERY caller including a super admin writing the
    // SYSTEM registry — the allow-list is a platform NETWORK boundary, not a
    // permission, and privilege does not make 169.254.169.254 safe to reach.
    await this.assertBaseUrlReachable(dto.baseUrl, scopedTenantId);
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
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    const tx = this.crossTenantLane(scopedTenantId);

    const existing = await this.mcpServerRepository.findEnabledById(id, tx);
    if (!existing) {
      throw new NotFoundException('MCP server not found');
    }
    // Existence first, privilege second — see the class doc.
    this.assertCanWriteRow(existing.tenantId);
    // Egress third, and ONLY when the URL is actually being changed: re-validating
    // an unchanged `baseUrl` would let a transient DNS failure block an edit to the
    // name. The row's existing URL is re-checked at CALL time by the harness anyway,
    // which is where a URL that went bad after the write is actually caught.
    if (dto.baseUrl !== undefined) {
      await this.assertBaseUrlReachable(dto.baseUrl, existing.tenantId);
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
    const scopedTenantId = tenantId ?? SYSTEM_TENANT_ID;
    const tx = this.crossTenantLane(scopedTenantId);

    const existing = await this.mcpServerRepository.findEnabledById(id, tx);
    if (!existing) {
      throw new NotFoundException('MCP server not found');
    }
    // Existence first, privilege second — see the class doc.
    this.assertCanWriteRow(existing.tenantId);
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

  /**
   * SSRF egress guard for a tenant-authored connector URL.
   *
   * Delegates the verdict to `EgressPolicyService`, which reads the platform
   * allow-list from `mcp.egress.allowedHosts` (`global-kv`, `failMode: 'closed'`),
   * resolves the host, and refuses any answer in a private / loopback /
   * link-local-metadata / CGNAT / multicast range. An unreadable allow-list denies.
   *
   * This is FEEDBACK, not the protection: DNS can change after the row is saved, so
   * the authoritative gate is the harness worker's call-time check
   * (`apps/harness/src/harness/tools/egress_guard.py`).
   */
  private async assertBaseUrlReachable(baseUrl: string, targetTenantId: string): Promise<void> {
    await this.egressPolicy.assertUrlAllowed(baseUrl, {
      tenantId: targetTenantId,
      actorUserId: this.requestUserId ?? null,
    });
  }

  /**
   * CREATE gate — there is no row yet, so nothing to hide: every refusal here is
   * a privilege refusal (403). The SYSTEM registry is the shared platform tier
   * and stays super-admin-owned; a customer tenant other than the caller's is
   * likewise a privilege refusal (the controller's `resolveScopedTenantIdOptional`
   * already 403s a foreign `?tenantId=` — this is the defence-in-depth copy).
   */
  private assertCanWriteTenant(targetTenantId: string): void {
    if (isSuperAdmin(this.requestUser)) return;
    if (targetTenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('The SYSTEM MCP registry is managed by super administrators only.');
    }
    if (targetTenantId !== this.tenantId) {
      throw new ForbiddenException('You do not have access to this tenant');
    }
  }

  /**
   * UPDATE / DELETE gate, applied to a row that has ALREADY been resolved.
   *
   * A SYSTEM row is readable by every tenant (the shared registry), so refusing
   * it is a privilege boundary → 403, and saying so leaks nothing. A row owned
   * by ANOTHER customer tenant must never be distinguishable from a row that
   * does not exist → 404. In practice the extended client's `[caller, SYSTEM]`
   * widening already makes a foreign row invisible; this branch is what keeps
   * that true if the row ever arrives through the unscoped base-client lane.
   */
  private assertCanWriteRow(rowTenantId: string): void {
    if (isSuperAdmin(this.requestUser)) return;
    if (rowTenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('The SYSTEM MCP registry is managed by super administrators only.');
    }
    if (rowTenantId !== this.tenantId) {
      throw new NotFoundException('MCP server not found');
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
