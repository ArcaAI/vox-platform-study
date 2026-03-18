import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

export class TenantBucketEntityMapper extends BaseMapper<Entities.TenantBucketEntity, Models.TenantBucket> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.TenantBucketEntity): Models.TenantBucket {
        return AutoClassMapper(
            entity,
            Models.TenantBucket,
            TenantBucketEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.TenantBucketEntity): Partial<Models.TenantBucket> {
        return AutoEntityChangeMapper(
            entity,
            Models.TenantBucket,
            TenantBucketEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.TenantBucket): Entities.TenantBucketEntity {
        return AutoClassMapper(
            dataModel,
            Entities.TenantBucketEntity,
            TenantBucketEntityMapperHandlers.$toDomain,
        );
    }
}

export const TenantBucketEntityMapperHandlers = createMapperHandlers<Entities.TenantBucketEntity, Models.TenantBucket>({
    $toPersistence: {
    },
    $toDomain: {
    },
});
