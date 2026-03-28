import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class ConsultationEntityMapper extends BaseMapper<Entities.ConsultationEntity, Models.Consultation> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationEntity): Models.Consultation {
    return AutoClassMapper(entity, Models.Consultation, ConsultationEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ConsultationEntity): Partial<Models.Consultation> {
    return AutoEntityChangeMapper(entity, Models.Consultation, ConsultationEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Consultation): Entities.ConsultationEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationEntity, ConsultationEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationEntityMapperHandlers = createMapperHandlers<Entities.ConsultationEntity, Models.Consultation>({
  $toPersistence: {},
  $toDomain: {},
});
