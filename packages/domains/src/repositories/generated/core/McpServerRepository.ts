import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { McpServerEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { McpServerEntityMapper } from '../../../mappers';
import { McpServer } from '../../../models';

/**
 * MCP external-tools registry repository.
 *
 * One row per (tenant, name) — enforced by the `McpServer_tenant_name_unique`
 * index. The reserved SYSTEM tenant owns the shared registry rows. `McpServer`
 * is a SYSTEM-shared read model, so the tenant-scope extension permits pinning
 * `tenantId` to either the caller OR the SYSTEM tenant (mirrors
 * `AiTaskDefaultRepository`); registry WRITES are additionally global-admin
 * only, enforced at the application/controller layer.
 */
@Injectable()
export class McpServerRepository extends Repository<McpServerEntity, McpServer> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'mcpServer', McpServerEntityMapper.getInstance());
  }

  /**
   * The row owned EXACTLY by `(tenantId, name)`, ENABLED only, or null when no
   * such server exists. Used for the create-time name-uniqueness pre-check.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findByTenantAndName(tenantId: string, name: string, tx?: Prisma.TransactionClient | any): Promise<McpServerEntity | null> {
    const where = { tenantId, name, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = await (tx as Record<string, any>).mcpServer.findFirst({ where });
      return model ? McpServerEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      // Only a genuine miss maps to null; a tenant-scope mismatch throw (a
      // cross-tenant read) must SURFACE rather than silently become "no row".
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }

  /**
   * ENABLED server row by id, or null when absent / not visible. Without a `tx`
   * the read goes through the extended (tenant-scoped) client — for this
   * SYSTEM-shared read model that widens to `[caller, SYSTEM]`, so a
   * cross-tenant row simply misses (→ 404 at the service). With a `tx`
   * (global-admin cross-tenant base-client lane) the caller has already scoped
   * the tenant explicitly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findEnabledById(id: string, tx?: Prisma.TransactionClient | any): Promise<McpServerEntity | null> {
    const where = { id, resourceStatus: ResourceStatusType.ENABLED };
    if (tx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = await (tx as Record<string, any>).mcpServer.findFirst({ where });
      return model ? McpServerEntityMapper.getInstance().toDomainEntity(model) : null;
    }
    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }

  /**
   * List ENABLED servers visible to the caller. Without a `tx` the extended
   * client widens the SYSTEM-shared read to `[caller, SYSTEM]` (no explicit
   * `tenantId` filter — passing one as an object would trip the tenant-scope
   * guard). With a `tx` (global-admin cross-tenant base-client lane) the caller
   * supplies the explicit `tenantIds` to scope to `[target, SYSTEM]`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listEnabled(tenantIds?: string[], tx?: Prisma.TransactionClient | any): Promise<McpServerEntity[]> {
    if (tx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models = await (tx as Record<string, any>).mcpServer.findMany({
        where: { tenantId: { in: tenantIds ?? [] }, resourceStatus: ResourceStatusType.ENABLED },
        orderBy: { name: 'asc' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return models.map((m: any) => McpServerEntityMapper.getInstance().toDomainEntity(m));
    }
    return this.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED }, sort: [{ name: 'asc' }] });
  }
}
