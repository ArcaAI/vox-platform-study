import { BaseEntity } from '../common';

export interface IMapper<DomainEntity extends BaseEntity, DataModel> {
    toPersistence(entity: DomainEntity): DataModel;
    toDomainEntity(dataModel: DataModel): DomainEntity;
}
