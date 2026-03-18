import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { WebhookEntityMapper } from '../../../mappers';
import { WebhookEntity } from '../../../entities';
import { Webhook } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class WebhookRepository extends Repository<WebhookEntity, Webhook> {
    constructor(
        private readonly unitOfWorkService: CoreUnitOfWorkService
    ) {
        super(unitOfWorkService, 'webhook', WebhookEntityMapper.getInstance(), undefined, ['name', 'url']);
    }
}