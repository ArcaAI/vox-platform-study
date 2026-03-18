import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { UserSettingsEntityMapper } from '../../../mappers';
import { UserSettingsEntity } from '../../../entities';
import { UserSettings } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class UserSettingsRepository extends Repository<UserSettingsEntity, UserSettings> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'userSettings', UserSettingsEntityMapper.getInstance(), undefined, ['name', 'key', 'namespace']);
    }

    /**
     * Find all settings for user with specific namespace
     * Used by UserPreferencesService for SDK preferences aggregation
     */
    async findByUserAndNamespace(
        userId: string,
        namespace: string
    ): Promise<UserSettingsEntity[]> {
        const models = await this.db.findMany({
            where: {
                userId,
                namespace,
                resourceStatus: ResourceStatusType.ENABLED,
            },
            orderBy: { key: 'asc' },
        });
        return models.map((model: UserSettings) =>
            UserSettingsEntityMapper.getInstance().toDomainEntity(model)
        );
    }

    /**
     * Find single setting by user, key, and namespace
     */
    async findByUserKeyNamespace(
        userId: string,
        key: string,
        namespace: string
    ): Promise<UserSettingsEntity | null> {
        const model = await this.db.findFirst({
            where: {
                userId,
                key,
                namespace,
                resourceStatus: ResourceStatusType.ENABLED,
            },
        });
        return model
            ? UserSettingsEntityMapper.getInstance().toDomainEntity(model)
            : null;
    }

    /**
     * Delete all settings for user with specific namespace (soft delete)
     */
    async deleteByUserAndNamespace(
        userId: string,
        namespace: string
    ): Promise<void> {
        await this.db.updateMany({
            where: {
                userId,
                namespace,
            },
            data: {
                resourceStatus: ResourceStatusType.DELETED,
                resourceStatusUpdatedAt: new Date(),
            },
        });
    }
}