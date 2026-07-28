import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, modelHasSoftDelete } from '@arcaai/database';
import { formatFindAllProps, formatCountProps, QueryBuilder, BaseEntity, BaseMapper, EntityId, CoreUnitOfWorkService } from '../common';
import { ICountProps, IFindAllProps, IRepository } from '../interfaces';

import { DataCreationException, DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceStatusType } from '../enums';
import { removeNullValues } from './removeNullValues';
import { getPhiReadSecrets, wrapDelegateWithPhiDecrypt } from './phi-read-decrypt';

// Type for the database context - can be extended client or transaction client
type DatabaseContext = ReturnType<PrismaClient['$extends']> | Prisma.TransactionClient;

@Injectable()
export abstract class Repository<DomainEntity extends BaseEntity, DatabaseModel> implements IRepository<DomainEntity, DatabaseModel> {
  private _databaseContext?: DatabaseContext;

  constructor(
    private readonly _unitOfWorkService: CoreUnitOfWorkService,
    protected readonly _modelName: string,
    private readonly _mapper: BaseMapper<DomainEntity, any>,
    private readonly _includes?: any,
    private readonly _defaultSearchFields?: string[],
  ) {
    this._databaseContext = this._unitOfWorkService.getDatabaseService();
  }

  protected get db(): any {
    if (!this._databaseContext) {
      this._databaseContext = this._unitOfWorkService.getDatabaseService();
    }
    // Use type assertion to handle the indexing
    const delegate = (this._databaseContext as Record<string, any>)[this._modelName];

    // Decrypt-on-read for the dropped plaintext PHI columns.
    // Only wrap when a SecretsService has been wired (Vault mode); env-mode dev
    // and unit tests leave it unwired, so this is a zero-overhead pass-through
    // there. Routing through `this.db` means BOTH the generic finders above and
    // every hand-written custom finder are covered by one wrap point, and the
    // recursive walk also decrypts nested PHI rows pulled in via `include` from
    // ANY repository (e.g. Consultation.ContextItems). The decryptor only acts
    // on the 26 registered `encrypted*` columns — all other models (GlobalSetting,
    // AuditLog, WORM) use distinct names and are untouched.
    if (getPhiReadSecrets()) {
      return wrapDelegateWithPhiDecrypt(delegate);
    }
    return delegate;
  }

  public async create(entity: DomainEntity, tx?: Prisma.TransactionClient | any): Promise<DomainEntity> {
    let data = this._mapper.toPersistence(entity);
    data = removeNullValues(data);

    // When a transaction client is supplied (atomic
    // multi-entity create, e.g. user + role + department membership), route the
    // write through it so it participates in the caller's `$transaction` and
    // rolls back with the rest on partial failure. Mirrors the existing
    // `updateWithVersion(..., tx)` contract. Without `tx` the cached extended
    // client (`this.db`) is used — behaviour unchanged.
    const delegate = tx ? (tx as Record<string, any>)[this._modelName] : this.db;

    const model = await delegate.create({
      data,
      include: this._includes,
    });
    if (!model) {
      throw new DataCreationException(delegate?.name || this._modelName || Repository.name);
    }
    return this._mapper.toDomainEntity(model);
  }

  /**
   * Create multiple entities in a single batch operation.
   * This is more efficient than calling create() multiple times.
   *
   * Note: Prisma's createMany doesn't return the created records,
   * so this method returns the count of created records.
   *
   * @param entities - Array of entities to create
   * @param skipDuplicates - If true, skip records that would cause unique constraint violations
   * @returns The count of created records
   */
  public async createMany(entities: DomainEntity[], skipDuplicates: boolean = true): Promise<{ count: number }> {
    if (entities.length === 0) {
      return { count: 0 };
    }

    const data = entities.map((entity) => {
      const mapped = this._mapper.toPersistence(entity);
      return removeNullValues(mapped);
    });

    const result = await this.db.createMany({
      data,
      skipDuplicates,
    });

    return { count: result.count };
  }

  public async findById(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.findUnique({
      where: { id },
      include: this._includes,
    });
    if (!model) {
      throw new DataNotFoundException(this.db.name || Repository.name, id);
    }
    return this._mapper.toDomainEntity(model);
  }

  public async findFirst(props: IFindAllProps<DatabaseModel>): Promise<DomainEntity> {
    const model = await this.db.findFirst({
      ...formatFindAllProps(this.applyDefaultSearchFields(props)),
      include: this._includes,
    });
    if (!model) {
      throw new DataNotFoundException(this.db.name || Repository.name, JSON.stringify(props));
    }
    return this._mapper.toDomainEntity(model);
  }

  public async findAll(props: IFindAllProps<DatabaseModel>): Promise<DomainEntity[]> {
    const models = await this.db.findMany({
      ...formatFindAllProps(this.applyDefaultSearchFields(props)),
      include: this._includes,
    });
    return models.map((model: DatabaseModel) => this._mapper.toDomainEntity(model));
  }

  public async count(props: ICountProps<DatabaseModel>): Promise<number> {
    return await this.db.count(formatCountProps(this.applyDefaultSearchFields(props)));
  }

  private applyDefaultSearchFields<T extends { search?: string; searchFields?: string[] }>(props: T): T {
    if (props.search && !props.searchFields && this._defaultSearchFields?.length) {
      return { ...props, searchFields: this._defaultSearchFields };
    }
    return props;
  }

  public async update(id: EntityId, entity: DomainEntity): Promise<DomainEntity> {
    const changes = this._mapper.toPersistenceChanges(entity);
    const model = await this.db.update({
      where: { id },
      data: changes,
      include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
  }

  /**
   * Compare-and-set update against the `_version` column.
   *
   * Issues `prisma.<model>.updateMany({ where: { id, version: expectedVersion },
   * data: { ...changes, version: { increment: 1 } } })`. PostgreSQL emits the
   * predicate verbatim; if no row matches we disambiguate "row gone" vs
   * "version drifted" by re-reading and throwing the correct exception.
   *
   * Safe under transaction-mode pooling — no row lock is taken.
   *
   * When `tx` is provided, the CAS predicate and the post-failure re-read
   * are both issued through the interactive Prisma transaction client; the
   * subsequent `findById` for the success-return shape is also routed via
   * `tx`. This lets callers (e.g. `TenantService.updateTenantConfigs` C.4)
   * compose a multi-row CAS batch inside a single Postgres transaction so
   * a mid-batch conflict rolls every prior row back via standard SQL
   * rollback semantics. When `tx` is omitted, behaviour is identical to
   * before C.4 — the cached extended client is used.
   *
   * @throws OptimisticConcurrencyException when the row exists but its
   *   version is no longer `expectedVersion`
   * @throws DataNotFoundException when the row no longer exists
   *
   * @see https://github.com/prisma/prisma/issues/10207 (MySQL-only caveat)
   */
  public async updateWithVersion(
    id: EntityId,
    entity: DomainEntity,
    expectedVersion: number,
    tx?: Prisma.TransactionClient | any,
  ): Promise<DomainEntity> {
    const changes = this._mapper.toPersistenceChanges(entity);

    // `version` is database-owned. Even if a buggy caller put it in the
    // change set, we strip it here as defense in depth on top of the
    // mapper $toPersistence handler and applyChangesToEntity filter.
    const { version: _v, ...safeChanges } = changes as Record<string, any>;

    // When a transaction client is supplied, route writes and the
    // disambiguating re-read through it; otherwise fall back to the
    // cached extended client (`this.db`).
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;

    const result = await model.updateMany({
      where: { id, version: expectedVersion },
      data: { ...safeChanges, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const current = await model.findUnique({
        where: { id },
        select: { version: true },
      });
      if (!current) {
        throw new DataNotFoundException(this._modelName, id);
      }
      throw new OptimisticConcurrencyException(this._modelName, id, {
        expectedVersion,
        currentVersion: current.version,
      });
    }

    // Read the freshly-bumped row through the same context so callers
    // inside `$transaction` see the in-flight write rather than the
    // snapshot of the outer connection.
    return this.findByIdInContext(id, tx);
  }

  /**
   * Variant of `findById` that uses the supplied transaction client when
   * one is provided. Kept private to the CAS path because no other call
   * site needs it today; promote to a generic helper if and when a second
   * caller appears.
   */
  private async findByIdInContext(id: EntityId, tx?: Prisma.TransactionClient | any): Promise<DomainEntity> {
    if (!tx) {
      return this.findById(id);
    }
    const model: any = (tx as Record<string, any>)[this._modelName];
    const found = await model.findUnique({
      where: { id },
      include: this._includes,
    });
    if (!found) {
      throw new DataNotFoundException(this._modelName, id);
    }
    return this._mapper.toDomainEntity(found);
  }

  public async delete(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.delete({
      where: { id },
      include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
  }

  /**
   * Whether this repository's underlying Prisma model supports soft-delete.
   * Models without a `resourceStatus` column (e.g. version history tables)
   * will return false, and softDelete/restore calls will throw.
   */
  public get supportsSoftDelete(): boolean {
    return modelHasSoftDelete(this._modelName);
  }

  /**
   * Soft delete an entity by setting its resourceStatus to DELETED
   *
   * @param id - The entity ID to soft delete
   * @param updatedBy - Optional user ID who performed the deletion
   * @returns The soft-deleted entity
   * @throws Error if the model does not support soft-delete
   */
  public async softDelete(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity> {
    if (!this.supportsSoftDelete) {
      throw new Error(`softDelete is not supported on model "${this._modelName}" because it has no resourceStatus column`);
    }
    const model = await this.db.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        ...(updatedBy && { resourceStatusUpdatedBy: updatedBy }),
        // Soft-delete is a real state change.
        // Bumping `_version` prevents a stale reader at v(n) from successfully
        // calling `updateWithVersion(…, n)` after another admin soft-deleted
        // the row, which would resurrect deleted PHI (compliance / SOC2 risk).
        version: { increment: 1 },
      },
      include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
  }

  /**
   * Restore a soft-deleted entity by setting its resourceStatus to ENABLED
   *
   * @param id - The entity ID to restore
   * @param updatedBy - Optional user ID who performed the restoration
   * @returns The restored entity
   * @throws Error if the model does not support soft-delete
   */
  public async restore(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity> {
    if (!this.supportsSoftDelete) {
      throw new Error(`restore is not supported on model "${this._modelName}" because it has no resourceStatus column`);
    }
    const model = await this.db.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.ENABLED,
        resourceStatusUpdatedAt: new Date(),
        ...(updatedBy && { resourceStatusUpdatedBy: updatedBy }),
        // Restore is the inverse state
        // change and must also bump so OCC tracks the resurrection cleanly.
        version: { increment: 1 },
      },
      include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
  }

  public async rawQuery(query: string): Promise<unknown> {
    return await this.db.query(query);
  }

  public async runQuery(query: QueryBuilder<DatabaseModel>): Promise<DomainEntity | DomainEntity[] | null> {
    const builtQuery = query.Build();
    return await this.db.findMany(builtQuery);
  }

  public query(): QueryBuilder<DatabaseModel> {
    return new QueryBuilder(this.db);
  }

  public $(): QueryBuilder<DatabaseModel> {
    return this.query();
  }
}
