import { BaseEntity, EntityId } from '../common';
import { QueryBuilder } from '../common';
import { IFindAllProps } from './IFindAllProps';
import { ICountProps } from './ICountProps';

export interface IRepository<DomainEntity extends BaseEntity, DatabaseModel> {
  findAll(props: IFindAllProps<DatabaseModel>): Promise<DomainEntity[]>;
  findById(id: EntityId): Promise<DomainEntity>;
  findFirst(props: IFindAllProps<DatabaseModel>): Promise<DomainEntity>;
  count(props: ICountProps<DatabaseModel>): Promise<number>;
  create(entity: DomainEntity): Promise<DomainEntity>;

  /**
   * Create multiple entities in a single batch operation.
   * More efficient than calling create() multiple times.
   *
   * @param entities - Array of entities to create
   * @param skipDuplicates - If true, skip records that would cause unique constraint violations
   * @returns The count of created records
   */
  createMany(entities: DomainEntity[], skipDuplicates?: boolean): Promise<{ count: number }>;

  update(id: EntityId, entity: DomainEntity): Promise<DomainEntity>;
  delete(id: EntityId): Promise<DomainEntity>;

  /**
   * Soft delete an entity by setting its resourceStatus to DELETED
   * The entity remains in the database but is filtered from normal queries
   *
   * @param id - The entity ID to soft delete
   * @param updatedBy - Optional user ID who performed the deletion
   */
  softDelete(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity>;

  /**
   * Restore a soft-deleted entity by setting its resourceStatus to ENABLED
   *
   * @param id - The entity ID to restore
   * @param updatedBy - Optional user ID who performed the restoration
   */
  restore(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity>;

  rawQuery(query: string): Promise<unknown>;
  runQuery(query: QueryBuilder<DatabaseModel>): Promise<DomainEntity | DomainEntity[] | null>;
  query(): QueryBuilder<DatabaseModel>;
  $(): QueryBuilder<DatabaseModel>;
}
