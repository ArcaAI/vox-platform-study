import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class PromptTemplateEntityMapper extends BaseMapper<Entities.PromptTemplateEntity, Models.PromptTemplate> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.PromptTemplateEntity): Models.PromptTemplate {
        return AutoClassMapper(
            entity,
            Models.PromptTemplate,
            PromptTemplateEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.PromptTemplateEntity): Partial<Models.PromptTemplate> {
        return AutoEntityChangeMapper(
            entity,
            Models.PromptTemplate,
            PromptTemplateEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.PromptTemplate): Entities.PromptTemplateEntity {
        return AutoClassMapper(
            dataModel,
            Entities.PromptTemplateEntity,
            PromptTemplateEntityMapperHandlers.$toDomain,
        );
    }
}

export const PromptTemplateEntityMapperHandlers = createMapperHandlers<Entities.PromptTemplateEntity, Models.PromptTemplate>({
    $toPersistence: {},
    $toDomain: {},
});
