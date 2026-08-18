import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ServiceAccountEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { ServiceAccountEntityMapper } from '../../../mappers';
import { ServiceAccount } from '../../../models';

/**
 * Service-account repository (TASK-762).
 *
 * HAND-AUTHORED — `gen:repository` is broken (`03-domain-layer.md`); follows
 * the `AiProviderConnectionRepository` precedent in this folder.
 *
 * ─── Why this model is NOT in `TENANT_SCOPED_MODELS` ─────────────────────────
 *
 * `findByClientId` is the AUTHENTICATION lookup for the token-exchange
 * endpoint: it runs BEFORE any principal — and therefore any tenant — exists.
 * Inside an HTTP request CLS is active but EMPTY (`tenantId === undefined` and
 * `isSuperAdmin() === false`), which is the exact combination the tenant-scope
 * extension's read handler throws on. `ApiKey` is excluded from that allow-list
 * for precisely this reason (see `INTENTIONALLY_UNSCOPED` in
 * `packages/database/src/extensions/__tests__/tenant-scope.test.ts`), and
 * `ServiceAccount` is the same pre-auth shape.
 *
 * The ticket README §5.1 says "Add to `TENANT_SCOPED_MODELS`"; that instruction
 * would have reproduced the BUG-scale failure the `ApiKey` comment documents
 * (every key on the platform authenticating as 401). Isolation is enforced one
 * layer up instead, in `ServiceAccountService`, on EVERY read path: list reads
 * go through the caller's CLS tenant, and every `findById` is followed by an
 * ownership assertion that throws `NotFoundException` (404-over-403). The only
 * unguarded read is `findByClientId` — the authentication lookup itself, which
 * matches on a unique identifier and whose row is what ESTABLISHES the context.
 */
@Injectable()
export class ServiceAccountRepository extends Repository<ServiceAccountEntity, ServiceAccount> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'serviceAccount', ServiceAccountEntityMapper.getInstance());
  }

  /**
   * The pre-auth token-exchange lookup. Returns ENABLED accounts only, so a
   * soft-deleted (revoked) account cannot exchange its secret at all — the
   * revocation is effective on the very next request, not after a TTL.
   */
  async findByClientId(clientId: string, tx?: Prisma.TransactionClient | any): Promise<ServiceAccountEntity | null> {
    const where = { clientId, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).serviceAccount.findFirst({ where });
      return model ? ServiceAccountEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Every ENABLED account for one tenant (admin list). Callers pass an explicit
   * `tenantId` — this model is not tenant-scope-injected (see the class doc).
   */
  async findByTenantId(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<ServiceAccountEntity[]> {
    const where = { tenantId, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const models = await (tx as Record<string, any>).serviceAccount.findMany({ where, orderBy: [{ displayName: 'asc' }] });
      const mapper = ServiceAccountEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort: [{ displayName: 'asc' }] });
  }

  /**
   * Stamp usage without going through the change-tracked update path.
   * Deliberately does NOT bump `_version`: a token exchange is not a
   * user-visible edit, and bumping the version would invalidate every
   * outstanding `If-Match` ETag on the admin surface on every machine call.
   */
  async touchLastUsedAt(id: string, at: Date = new Date(), tx?: Prisma.TransactionClient | any): Promise<void> {
    const delegate = tx ? (tx as Record<string, any>).serviceAccount : this.db;
    await delegate.update({ where: { id }, data: { lastUsedAt: at } });
  }
}
