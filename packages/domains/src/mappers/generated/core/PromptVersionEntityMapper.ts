import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

const FIELDS_NOT_IN_PRISMA: string[] = [
    'createdBy', 'updatedBy', 'updatedAt',
    'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy',
];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
    for (const field of fields) {
        delete (model as Record<string, unknown>)[field];
    }
    return model;
}

export class PromptVersionEntityMapper extends BaseMapper<Entities.PromptVersionEntity, Models.PromptVersion> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.PromptVersionEntity): Models.PromptVersion {
        const result = AutoClassMapper(
            entity,
            Models.PromptVersion,
            PromptVersionEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toPersistenceChanges(entity: Entities.PromptVersionEntity): Partial<Models.PromptVersion> {
        const result = AutoEntityChangeMapper(
            entity,
            Models.PromptVersion,
            PromptVersionEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toDomainEntity(dataModel: Models.PromptVersion): Entities.PromptVersionEntity {
        return AutoClassMapper(
            dataModel,
            Entities.PromptVersionEntity,
            PromptVersionEntityMapperHandlers.$toDomain,
        );
    }
}

export const PromptVersionEntityMapperHandlers = createMapperHandlers<Entities.PromptVersionEntity, Models.PromptVersion>({
    $toPersistence: {},
    $toDomain: {},
});
