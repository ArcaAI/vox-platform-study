import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class DnaWritingStyleReportEntityMapper extends BaseMapper<Entities.DnaWritingStyleReportEntity, Models.DnaWritingStyleReport> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.DnaWritingStyleReportEntity): Models.DnaWritingStyleReport {
        return AutoClassMapper(
            entity,
            Models.DnaWritingStyleReport,
            DnaWritingStyleReportEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.DnaWritingStyleReportEntity): Partial<Models.DnaWritingStyleReport> {
        return AutoEntityChangeMapper(
            entity,
            Models.DnaWritingStyleReport,
            DnaWritingStyleReportEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.DnaWritingStyleReport): Entities.DnaWritingStyleReportEntity {
        return AutoClassMapper(
            dataModel,
            Entities.DnaWritingStyleReportEntity,
            DnaWritingStyleReportEntityMapperHandlers.$toDomain,
        );
    }
}

export const DnaWritingStyleReportEntityMapperHandlers = createMapperHandlers<Entities.DnaWritingStyleReportEntity, Models.DnaWritingStyleReport>({
    $toPersistence: {},
    $toDomain: {},
});
