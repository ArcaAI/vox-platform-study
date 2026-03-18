import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

const FIELDS_NOT_IN_PRISMA: string[] = [
    'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy',
];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
    for (const field of fields) {
        delete (model as Record<string, unknown>)[field];
    }
    return model;
}

export class SummaryMetaEntityMapper extends BaseMapper<Entities.SummaryMetaEntity, Models.SummaryMeta> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.SummaryMetaEntity): Models.SummaryMeta {
        const result = AutoClassMapper(
            entity,
            Models.SummaryMeta,
            SummaryMetaEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toPersistenceChanges(entity: Entities.SummaryMetaEntity): Partial<Models.SummaryMeta> {
        const result = AutoEntityChangeMapper(
            entity,
            Models.SummaryMeta,
            SummaryMetaEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toDomainEntity(dataModel: Models.SummaryMeta): Entities.SummaryMetaEntity {
        return AutoClassMapper(
            dataModel,
            Entities.SummaryMetaEntity,
            SummaryMetaEntityMapperHandlers.$toDomain,
        );
    }
}

export const SummaryMetaEntityMapperHandlers = createMapperHandlers<Entities.SummaryMetaEntity, Models.SummaryMeta>({
    $toPersistence: {
    },
    $toDomain: {
    },
});
