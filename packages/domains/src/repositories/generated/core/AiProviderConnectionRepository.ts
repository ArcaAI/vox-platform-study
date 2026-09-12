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
 * TASK-958: identity is `(tenant, service, SLUG)` — enforced by the
 * `AiProviderConnection_tenant_service_slug_key` index — and a second unique,
 * `AiProviderConnection_tenant_service_default_key`, makes "at most one DEFAULT
 * row per (tenant, service, provider)" a database fact. A tenant may hold any
 * number of named siblings for one provider; the SYSTEM tier stays one row per
 * provider and the SYSTEM row is the platform default. `AiProviderConnection` is a
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
   * The (tenant, service, SLUG) lookup — the IDENTITY read. TASK-958's
   * replacement for `findByTenantServiceProvider` on every by-name route.
   *
   * Accepts an optional transaction/base client so a super admin acting on a
   * foreign tenant (or the SYSTEM tenant) can read through the unscoped lane —
   * without it the tenant-scope extension injects the admin's working tenant
   * and the read silently misses.
   */
  async findByTenantServiceSlug(
    service: string,
    slug: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findOne({ tenantId, service, slug, resourceStatus: ResourceStatusType.ENABLED }, tx);
  }

  /**
   * EVERY live connection a tenant holds for one `(service, provider)` — the
   * default first, then oldest-first.
   *
   * The ordering is load-bearing, not cosmetic: it is what the cascade reads to
   * pick the default deterministically, and what an admin list renders. Sorting
   * on `defaultForProvider` puts the default ahead of its siblings because the
   * siblings carry NULL and Postgres sorts NULLs LAST on an ASC order by
   * default — so the one non-NULL value comes first.
   */
  async findAllByTenantServiceProvider(
    service: string,
    provider: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity[]> {
    const where = { tenantId, service, provider, resourceStatus: ResourceStatusType.ENABLED };
    const sort = [{ defaultForProvider: 'asc' as const }, { createdAt: 'asc' as const }];

    if (tx) {
      const models = await (tx as Record<string, any>).aiProviderConnection.findMany({ where, orderBy: sort });
      const mapper = AiProviderConnectionEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort });
  }

  /**
   * The tenant's DEFAULT connection for one `(service, provider)` — the single
   * row the provider-NAME cascade resolves to, and therefore the row every
   * caller that still resolves by provider name gets.
   *
   * Reads `defaultForProvider`, which is unique per (tenant, service, provider),
   * so this cannot be ambiguous the way a `findFirst` over the provider was
   * before TASK-958.
   */
  async findDefaultByTenantServiceProvider(
    service: string,
    provider: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findOne(
      { tenantId, service, defaultForProvider: provider, resourceStatus: ResourceStatusType.ENABLED },
      tx,
    );
  }

  /**
   * @deprecated TASK-958 — an alias of `findDefaultByTenantServiceProvider`.
   * A provider no longer identifies a connection: it identifies a GROUP of
   * them, of which exactly one is the default. Callers that mean "the row the
   * cascade uses" should say `findDefaultByTenantServiceProvider`; callers that
   * mean a specific connection want `findByTenantServiceSlug`. Removed in R4.
   */
  async findByTenantServiceProvider(
    service: string,
    provider: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findDefaultByTenantServiceProvider(service, provider, tenantId, tx);
  }

  /**
   * Shared read for the single-row lookups above.
   *
   * Only a genuine miss maps to null. Anything else — most importantly the
   * tenant-scope extension's `TenantScope: tenantId mismatch` throw on a
   * cross-tenant read — must SURFACE, or a super-admin read targeting a foreign
   * tenant would silently "succeed" as empty (r2605 Finding A).
   */
  private async findOne(
    where: Record<string, unknown>,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    if (tx) {
      const model = await (tx as Record<string, any>).aiProviderConnection.findFirst({ where });
      return model ? AiProviderConnectionEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where as any });
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Same (tenant, service, SLUG) identity as `findByTenantServiceSlug`, but
   * looks specifically for a soft-DELETED row. The unique
   * `AiProviderConnection_tenant_service_slug_key` index means a soft-deleted
   * tombstone occupies the identity a plain INSERT would otherwise use;
   * `ProviderConnectionService.upsertRow`'s create-intent path
   * (`If-Match: "0"`) calls this to restore-with-overwrite instead of colliding
   * with the tombstone (F-028).
   *
   * TASK-958 renamed this from `findDeletedByTenantServiceProvider`: after the
   * split a tombstone blocks a SLUG, not a provider — a deleted sibling never
   * stood in the way of a new default, and looking one up by provider would
   * have returned an arbitrary tombstone of the group.
   */
  async findDeletedByTenantServiceSlug(
    service: string,
    slug: string,
    tenantId: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findOne({ tenantId, service, slug, resourceStatus: ResourceStatusType.DELETED }, tx);
  }

  /**
   * Every ENABLED connection row for one tenant WITHIN one service (admin list +
   * BYO resolution). Filtering by `service` keeps an `llm` resolver from ever
   * seeing an `stt`/`tts` row and vice-versa.
   */
  async findByTenantIdAndService(service: string, tenantId: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity[]> {
    const where = { tenantId, service, resourceStatus: ResourceStatusType.ENABLED };
    // TASK-958 — group by provider, DEFAULT first inside each group, then
    // oldest-first. `defaultForProvider` is NULL on a sibling and Postgres
    // sorts NULLs last on ASC, so the default leads its own group.
    const sort = [{ provider: 'asc' as const }, { defaultForProvider: 'asc' as const }, { createdAt: 'asc' as const }];

    if (tx) {
      const models = await (tx as Record<string, any>).aiProviderConnection.findMany({ where, orderBy: sort });
      const mapper = AiProviderConnectionEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort });
  }

  // ===== Deprecated pre-unification wrappers (removed by the adoption lanes) =

  /** @deprecated Use `findDefaultByTenantServiceProvider('llm', provider, tenantId, tx)`. */
  async findByTenantAndProvider(tenantId: string, provider: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity | null> {
    return this.findByTenantServiceProvider('llm', provider, tenantId, tx);
  }

  /** @deprecated Use `findDeletedByTenantServiceSlug('llm', slug, tenantId, tx)`. */
  async findDeletedByTenantAndProvider(
    tenantId: string,
    provider: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<AiProviderConnectionEntity | null> {
    return this.findDeletedByTenantServiceSlug('llm', provider, tenantId, tx);
  }

  /** @deprecated Use `findByTenantIdAndService('llm', tenantId, tx)`. */
  async findByTenantId(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<AiProviderConnectionEntity[]> {
    return this.findByTenantIdAndService('llm', tenantId, tx);
  }
}
