import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantCheckpointRestoreEntity } from '../../../entities';
import { ResourceStatusType, TenantCheckpointRestoreStatus } from '../../../enums';
import { TenantCheckpointRestoreEntityMapper } from '../../../mappers';
import { TenantCheckpointRestore } from '../../../models';

@Injectable()
export class TenantCheckpointRestoreRepository extends Repository<TenantCheckpointRestoreEntity, TenantCheckpointRestore> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantCheckpointRestore', TenantCheckpointRestoreEntityMapper.getInstance());
  }

  private delegateFor(tx?: Prisma.TransactionClient | any): any {
    return tx ? (tx as Record<string, any>).tenantCheckpointRestore : this.db;
  }

  private toEntities(rows: TenantCheckpointRestore[]): TenantCheckpointRestoreEntity[] {
    const mapper = TenantCheckpointRestoreEntityMapper.getInstance();
    return rows.map((row) => mapper.toDomainEntity(row));
  }

  private static readonly TERMINAL = [
    TenantCheckpointRestoreStatus.COMPLETED,
    TenantCheckpointRestoreStatus.COMPLETED_WITH_WARNINGS,
    TenantCheckpointRestoreStatus.FAILED,
  ];

  /** The tenant's restore that has not reached a terminal status, or null. */
  async findActiveByTenant(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<TenantCheckpointRestoreEntity | null> {
    const row = await this.delegateFor(tx).findFirst({
      where: {
        tenantId,
        resourceStatus: { not: ResourceStatusType.DELETED },
        status: { notIn: TenantCheckpointRestoreRepository.TERMINAL },
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? TenantCheckpointRestoreEntityMapper.getInstance().toDomainEntity(row as TenantCheckpointRestore) : null;
  }

  /** Newest-first page of one tenant's restores. */
  async findByTenant(
    tenantId: string,
    opts: { skip: number; take: number },
    tx?: Prisma.TransactionClient | any,
  ): Promise<{ rows: TenantCheckpointRestoreEntity[]; total: number }> {
    const where = { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } };
    const delegate = this.delegateFor(tx);
    const [rows, total] = await Promise.all([
      delegate.findMany({ where, orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], skip: opts.skip, take: opts.take }),
      delegate.count({ where }),
    ]);
    return { rows: this.toEntities(rows as TenantCheckpointRestore[]), total: total as number };
  }

  /** ANY tenant (worker sweep): non-terminal restores whose heartbeat is older than `heartbeatBefore`. */
  async findStaleActive(heartbeatBefore: Date, tx?: Prisma.TransactionClient | any): Promise<TenantCheckpointRestoreEntity[]> {
    const rows = await this.delegateFor(tx).findMany({
      where: {
        resourceStatus: { not: ResourceStatusType.DELETED },
        status: { notIn: TenantCheckpointRestoreRepository.TERMINAL },
        heartbeatAt: { lt: heartbeatBefore },
      },
      orderBy: { heartbeatAt: 'asc' },
    });
    return this.toEntities(rows as TenantCheckpointRestore[]);
  }
}
