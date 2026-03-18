import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { NotificationEntityMapper } from '../../../mappers';
import { NotificationEntity } from '../../../entities';
import { Notification } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class NotificationRepository extends Repository<NotificationEntity, Notification> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'notification', NotificationEntityMapper.getInstance(), undefined, ['title', 'messageText']);
    }
}