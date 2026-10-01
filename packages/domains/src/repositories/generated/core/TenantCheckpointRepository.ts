import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreDatabaseService } from '../../../common/databaseServices/core/core.database.service';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantCheckpointEntity } from '../../../entities';
import { ResourceStatusType, TenantCheckpointKind, TenantCheckpointStatus } from '../../../enums';
import { TenantCheckpointEntityMapper } from '../../../mappers';
import { TenantCheckpoint } from '../../../models';

@Injectable()
export class TenantCheckpointRepository extends Repository<TenantCheckpointEntity, TenantCheckpoint> {
  constructor(
    private readonly unitOfWorkService: CoreUnitOfWorkService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(unitOfWorkService, 'tenantCheckpoint', TenantCheckpointEntityMapper.getInstance());
  }

  private delegateFor(tx?: Prisma.TransactionClient | any): any {
    return tx ? (tx as Record<string, any>).tenantCheckpoint : this.db;
  }

  /**
   * The base Prisma client's delegate — NO tenant-scope and NO soft-delete extension.
   *
   * Used ONLY by the "ANY tenant" worker scans below (the checkpoint sweepers). Those run from a
   * cron with no tenant in context by design: their job is to find rows across every tenant and then
   * handle each one inside THAT row's tenant worker session. Through the scoped client they either
   * throw `TenantScope: tenant context required` (any CLS context without a tenant) or depend on the
   * accident of no CLS being active at all. Soft-deleted rows are filtered explicitly here because the
   * base client carries neither extension. Precedent: `RbacRoleRepository.unscopedDelegate`,
   * `WorkflowWebhookSecretRepository.findByHookIdUnscoped`.
   */
  private get unscoped(): any {
    return (this.databaseService.baseClient as unknown as Record<string, unknown>).tenantCheckpoint;
  }

  private toEntities(rows: TenantCheckpoint[]): TenantCheckpointEntity[] {
    const mapper = TenantCheckpointEntityMapper.getInstance();
    return rows.map((row) => mapper.toDomainEntity(row));
  }

  /** Newest-first page of one tenant's checkpoints, optionally narrowed to a kind. */
  async findByTenant(
    tenantId: string,
    opts: { skip: number; take: number; kind?: 'MANUAL' | 'SAFETY' },
    tx?: Prisma.TransactionClient | any,
  ): Promise<{ rows: TenantCheckpointEntity[]; total: number }> {
    const where: Record<string, unknown> = { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } };
    if (opts.kind) where.kind = opts.kind as TenantCheckpointKind;
    const delegate = this.delegateFor(tx);
    const [rows, total] = await Promise.all([
      delegate.findMany({ where, orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], skip: opts.skip, take: opts.take }),
      delegate.count({ where }),
    ]);
    return { rows: this.toEntities(rows as TenantCheckpoint[]), total: total as number };
  }

  /** In-flight checkpoints of one tenant: status PENDING, UPLOADING or RUNNING. */
  async findRunningByTenant(tenantId: string, tx?: Prisma.TransactionClient | any): Promise<TenantCheckpointEntity[]> {
    const rows = await this.delegateFor(tx).findMany({
      where: {
        tenantId,
        resourceStatus: { not: ResourceStatusType.DELETED },
        status: { in: [TenantCheckpointStatus.PENDING, TenantCheckpointStatus.UPLOADING, TenantCheckpointStatus.RUNNING] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return this.toEntities(rows as TenantCheckpoint[]);
  }

  /** ANY tenant (worker sweep): RUNNING checkpoints whose heartbeat is older than `heartbeatBefore`. */
  async findStale(heartbeatBefore: Date, tx?: Prisma.TransactionClient | any): Promise<TenantCheckpointEntity[]> {
    const rows = await (tx ? this.delegateFor(tx) : this.unscoped).findMany({
      where: {
        status: TenantCheckpointStatus.RUNNING,
        heartbeatAt: { lt: heartbeatBefore },
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
      orderBy: { heartbeatAt: 'asc' },
    });
    return this.toEntities(rows as TenantCheckpoint[]);
  }

  /** ANY tenant (worker sweep): READY checkpoints whose `expiresAt` is before `now`. */
  async findExpired(now: Date, tx?: Prisma.TransactionClient | any): Promise<TenantCheckpointEntity[]> {
    const rows = await (tx ? this.delegateFor(tx) : this.unscoped).findMany({
      where: {
        status: TenantCheckpointStatus.READY,
        expiresAt: { lt: now },
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
      orderBy: { expiresAt: 'asc' },
    });
    return this.toEntities(rows as TenantCheckpoint[]);
  }

  /** ANY tenant (worker sweep, unscoped read): UPLOADING checkpoints idle since before `updatedBefore`. */
  async findIdleUploads(updatedBefore: Date): Promise<TenantCheckpointEntity[]> {
    const rows = await this.unscoped.findMany({
      where: {
        status: TenantCheckpointStatus.UPLOADING,
        updatedAt: { lt: updatedBefore },
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
      orderBy: { updatedAt: 'asc' },
    });
    return this.toEntities(rows as TenantCheckpoint[]);
  }

  /** ANY tenant (retention sweep, unscoped read): every READY checkpoint. */
  async findReadyAnyTenant(): Promise<TenantCheckpointEntity[]> {
    const rows = await this.unscoped.findMany({
      where: { status: TenantCheckpointStatus.READY, resourceStatus: { not: ResourceStatusType.DELETED } },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'desc' }],
    });
    return this.toEntities(rows as TenantCheckpoint[]);
  }
}
