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

export class AudioRecordingEntityMapper extends BaseMapper<Entities.AudioRecordingEntity, Models.AudioRecording> {
    constructor() {
        super();
    }

    public toPersistence(entity: Entities.AudioRecordingEntity): Models.AudioRecording {
        const result = AutoClassMapper(
            entity,
            Models.AudioRecording,
            AudioRecordingEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toPersistenceChanges(entity: Entities.AudioRecordingEntity): Partial<Models.AudioRecording> {
        const result = AutoEntityChangeMapper(
            entity,
            Models.AudioRecording,
            AudioRecordingEntityMapperHandlers.$toPersistence,
        );
        return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
    }

    public toDomainEntity(dataModel: Models.AudioRecording): Entities.AudioRecordingEntity {
        return AutoClassMapper(
            dataModel,
            Entities.AudioRecordingEntity,
            AudioRecordingEntityMapperHandlers.$toDomain,
        );
    }
}

export const AudioRecordingEntityMapperHandlers = createMapperHandlers<Entities.AudioRecordingEntity, Models.AudioRecording>({
    $toPersistence: {
    },
    $toDomain: {
    },
});
