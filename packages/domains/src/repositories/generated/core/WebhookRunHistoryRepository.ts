import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { WebhookRunHistoryEntityMapper } from '../../../mappers';
import { WebhookRunHistoryEntity } from '../../../entities';
import { WebhookRunHistory } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class WebhookRunHistoryRepository extends Repository<WebhookRunHistoryEntity, WebhookRunHistory> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'webhookRunHistory', WebhookRunHistoryEntityMapper.getInstance());
    }
}