import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class TenantEntityMapper extends BaseMapper<Entities.TenantEntity, Models.Tenant> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.TenantEntity): Models.Tenant {
        return AutoClassMapper(
            entity,
            Models.Tenant,
            TenantEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.TenantEntity): Partial<Models.Tenant> {
        return AutoEntityChangeMapper(
            entity,
            Models.Tenant,
            TenantEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.Tenant): Entities.TenantEntity {
        return AutoClassMapper(
            dataModel,
            Entities.TenantEntity,
            TenantEntityMapperHandlers.$toDomain,
        );
    }
}

export const TenantEntityMapperHandlers = createMapperHandlers<Entities.TenantEntity, Models.Tenant>({
    $toPersistence: {
    },
    $toDomain: {
    },
});