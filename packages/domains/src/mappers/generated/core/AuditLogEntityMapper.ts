import {
    AutoClassMapper,
    AutoEntityChangeMapper,
    BaseMapper,
    createMapperHandlers,
} from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class AuditLogEntityMapper extends BaseMapper<Entities.AuditLogEntity, Models.AuditLog> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.AuditLogEntity): Models.AuditLog {
        return AutoClassMapper(
            entity,
            Models.AuditLog,
            AuditLogEntityMapperHandlers.$toPersistence,
        );
    }

    public toPersistenceChanges(entity: Entities.AuditLogEntity): Partial<Models.AuditLog> {
        return AutoEntityChangeMapper(
            entity,
            Models.AuditLog,
            AuditLogEntityMapperHandlers.$toPersistence,
        );
    }

    public toDomainEntity(dataModel: Models.AuditLog): Entities.AuditLogEntity {
        return AutoClassMapper(
            dataModel,
            Entities.AuditLogEntity,
            AuditLogEntityMapperHandlers.$toDomain,
        );
    }
}

export const AuditLogEntityMapperHandlers = createMapperHandlers<Entities.AuditLogEntity, Models.AuditLog>({
    $toPersistence: {
    },
    $toDomain: {
    },
});