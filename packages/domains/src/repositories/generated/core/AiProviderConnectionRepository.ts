import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiProviderConnectionEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { AiProviderConnectionEntityMapper } from '../../../mappers';
import { AiProviderConnection } from '../../../models';

/**
 * Provider-connection repository (config-plane core).
 *
 * HAND-AUTHORED — the `gen:repository` generator crashes pre-existingly; this
 * follows the `AiTaskDefaultRepository` / `TenantSttConfigRepository`
 * precedent in this folder.
 *
 * One row per (tenant, service, provider) — enforced by the
 * `AiProviderConnection_tenant_service_provider_unique` index. The reserved
 * SYSTEM tenant row is the platform default. `AiProviderConnection` is a
 * SYSTEM-shared read model, so the tenant-scope extension permits pinning
 * `tenantId` to either the caller OR the SYSTEM tenant; the tenant → SYSTEM
 * cascade itself is resolved by `ProviderConnectionService.resolveConnection`.
 *
 * The lookups are `service`-first (unification). The pre-unification
 * `findByTenantAndProvider` / `findByTenantId` names are retained as thin
 * deprecated wrappers defaulting `service='llm'` so nothing breaks mid-migration
 * (removed by the adoption lanes once every caller passes `service`).
 *
 * NOTE: rows carry Vault-Transit ciphertext in `encryptedApiKey`. This
 * repository returns it on the entity (the gateway resolution path needs it),
 * but NO read DTO may ever surface it — see `AiProviderConnectionDtoMapper`.
 */
@Injectable()
export class AiProviderConnectionRepository extends Repository<AiProviderConnectionEntity, AiProviderConnection> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'aiProviderConnection', AiProviderConnectionEntityMapper.getInstance());
  }

  // ===== Custom Query Methods (service-first) =====

  /**
   * The (tenant, service, provider) lookup that drives the resolution cascade.
   *
   * Accepts an optional transaction/base client so a global admin acting on a
   * foreign tenant (or the SYSTEM tenant) can read through the unscoped lane —
   * without it the tenant-scope extension injects the admin's working tenant
   * and the read silently misses.
   */
  async findByTenantServiceProvider(
    service: string,
    provider: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    const where = { tenantId, service, provider, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).aiProviderConnection.findFirst({ where });
      return model ? AiProviderConnectionEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      // Only a genuine miss maps to null. Anything else — most importantly the
      // tenant-scope extension's `TenantScope: tenantId mismatch` throw on a
      // cross-tenant read — must SURFACE, or a global-admin read targeting a
      // foreign tenant would silently "succeed" as empty (r2605 Finding A).
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Same (tenant, service, provider) identity as `findByTenantServiceProvider`,
   * but looks specifically for a soft-DELETED row. The unique
   * `AiProviderConnection_tenant_service_provider_unique` index means a
   * soft-deleted tombstone occupies the identity a plain INSERT would otherwise
   * use; `ProviderConnectionService.upsertRow`'s create-intent path
   * (`If-Match: "0"`) calls this to restore-with-overwrite instead of
   * colliding with the tombstone (F-028).
   */
  async findDeletedByTenantServiceProvider(
    service: string,
    provider: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    const where = { tenantId, service, provider, resourceStatus: ResourceStatusType.DELETED };

    if (tx) {
      const model = await (tx as Record<string, any>).aiProviderConnection.findFirst({ where });
      return model ? AiProviderConnectionEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Every ENABLED connection row for one tenant WITHIN one service (admin list +
   * BYO resolution). Filtering by `service` keeps an `llm` resolver from ever
   * seeing an `stt`/`tts` row and vice-versa.
   */
  async findByTenantIdAndService(service: string, tenantId: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity[]> {
    const where = { tenantId, service, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const models = await (tx as Record<string, any>).aiProviderConnection.findMany({
        where,
        orderBy: [{ provider: 'asc' }],
      });
      const mapper = AiProviderConnectionEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort: [{ provider: 'asc' }] });
  }

  // ===== Deprecated pre-unification wrappers (removed by the adoption lanes) =

  /** @deprecated Use `findByTenantServiceProvider('llm', provider, tenantId, tx)`. */
  async findByTenantAndProvider(tenantId: string, provider: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity | null> {
    return this.findByTenantServiceProvider('llm', provider, tenantId, tx);
  }

  /** @deprecated Use `findDeletedByTenantServiceProvider('llm', provider, tenantId, tx)`. */
  async findDeletedByTenantAndProvider(
    tenantId: string,
    provider: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findDeletedByTenantServiceProvider('llm', provider, tenantId, tx);
  }

  /** @deprecated Use `findByTenantIdAndService('llm', tenantId, tx)`. */
  async findByTenantId(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity[]> {
    return this.findByTenantIdAndService('llm', tenantId, tx);
  }
}
