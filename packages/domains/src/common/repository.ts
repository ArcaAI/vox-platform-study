import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, modelHasSoftDelete } from '@arcaai/database';
import { formatFindAllProps, formatCountProps, QueryBuilder, BaseEntity, BaseMapper, EntityId, CoreUnitOfWorkService } from '../common';
import { ICountProps, IFindAllProps, IRepository } from '../interfaces';

import { DataCreationException, DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceStatusType } from '../enums';

// Type for the database context - can be extended client or transaction client
type DatabaseContext = ReturnType<PrismaClient['$extends']> | Prisma.TransactionClient;

@Injectable()
export abstract class Repository<DomainEntity extends BaseEntity, DatabaseModel> implements IRepository<DomainEntity, DatabaseModel> {
  private _databaseContext?: DatabaseContext;

  constructor(
    private readonly _unitOfWorkService: CoreUnitOfWorkService,
    protected readonly _modelName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly _mapper: BaseMapper<DomainEntity, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly _includes?: any,
    private readonly _defaultSearchFields?: string[],
  ) {
    this._databaseContext = this._unitOfWorkService.getDatabaseService();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected get db(): any {
    if (!this._databaseContext) {
      this._databaseContext = this._unitOfWorkService.getDatabaseService();
    }
    // Use type assertion to handle the indexing
    return (this._databaseContext as Record<string, any>)[this._modelName];
  }

  public async create(entity: DomainEntity): Promise<DomainEntity> {
    let data = this._mapper.toPersistence(entity);
    data = removeNullValues(data);

    const model = await this.db.create({
      data,
      include: this._includes,
    });
    if (!model) {
      throw new DataCreationException(this.db.name || Repository.name);
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
   * @throws OptimisticConcurrencyException when the row exists but its
   *   version is no longer `expectedVersion`
   * @throws DataNotFoundException when the row no longer exists
   *
   * @see TASK-302 Stream D Phase B
   * @see https://github.com/prisma/prisma/issues/10207 (MySQL-only caveat)
   */
  public async updateWithVersion(
    id: EntityId,
    entity: DomainEntity,
    expectedVersion: number,
  ): Promise<DomainEntity> {
    const changes = this._mapper.toPersistenceChanges(entity);

    // `version` is database-owned. Even if a buggy caller put it in the
    // change set, we strip it here as defense in depth on top of the
    // mapper $toPersistence handler and applyChangesToEntity filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    const { version: _v, ...safeChanges } = changes as Record<string, any>;

    const result = await this.db.updateMany({
      where: { id, version: expectedVersion },
      data: { ...safeChanges, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const current = await this.db.findUnique({
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

    return this.findById(id);
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
      },
      include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
  }

  public async rawQuery(query: string): Promise<unknown> {
    return await this.db.query(query);
  }

  public async rawQueryUnsafe(query: string): Promise<unknown> {
    return await this.db.queryRawUnsafe(query);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public $bulk(txns: any[]): Promise<void> {
    return this.db.transaction(txns);
  }
}

function removeNullValues(obj: Record<string, any>): Record<string, any> {
  // Create a new object to avoid mutating the original object
  const cleanedObject: Record<string, any> = {};

  // Iterate over each key in the object
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      // Skip keys with null values
      continue;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Recursively clean nested objects
      cleanedObject[key] = removeNullValues(value);
    } else {
      // Assign the value if it's not null
      cleanedObject[key] = value;
    }
  }

  return cleanedObject;
}
