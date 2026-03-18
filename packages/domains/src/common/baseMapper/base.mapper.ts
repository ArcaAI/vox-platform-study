// Import directly to avoid circular dependency through barrel exports
import { BaseEntity } from '../baseEntity/base.entity';
import { Singleton } from '../singleton';

export abstract class BaseMapper<
    DomainEntity extends BaseEntity,
    DataModel
> extends Singleton {
    /**
     * Converts a domain entity to its corresponding data model.
     * @param entity The domain entity instance
     * @returns The data model instance
     */
    abstract toPersistence(entity: DomainEntity): DataModel;

    /**
     * Converts the changes found in the changes object to its corresponding data model.
     * @param entity The domain entity instance
     * @returns The data model instance
     */
    abstract toPersistenceChanges(entity: DomainEntity): Partial<DataModel>;

    /**
     * Converts a data model to its corresponding domain entity.
     * @param model The data model instance
     * @returns The domain entity instance
     */
    abstract toDomainEntity(model: DataModel): DomainEntity;

    toDbJson(data: unknown): string | null {
        if (typeof data === 'object') {
            return JSON.stringify(data);
        }
        return null;
    }
}
