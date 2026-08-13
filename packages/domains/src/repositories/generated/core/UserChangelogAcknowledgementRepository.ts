import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { UserChangelogAcknowledgementEntity } from '../../../entities';
import { UserChangelogAcknowledgementEntityMapper } from '../../../mappers';
import { UserChangelogAcknowledgement } from '../../../models';

/**
 * Per-user, per-entry acknowledgement repository — one row per
 * (userId, changelogEntryId), enforced by `UserChangelogAck_user_entry_unique`.
 * Scoped to the acknowledging user's own tenant.
 */
@Injectable()
export class UserChangelogAcknowledgementRepository extends Repository<UserChangelogAcknowledgementEntity, UserChangelogAcknowledgement> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'userChangelogAcknowledgement', UserChangelogAcknowledgementEntityMapper.getInstance());
  }
}
