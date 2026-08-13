import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ChangelogEntryEntity } from '../../../entities';
import { ChangelogEntryEntityMapper } from '../../../mappers';
import { ChangelogEntry } from '../../../models';

/**
 * Curated release-notes repository — one row per platform
 * (`ALL-`) train version, enforced by `ChangelogEntry_platformVersion_unique`.
 * The ONE human-edited, OCC model here — writes on a versioned PATCH route go
 * through `updateWithVersion`.
 */
@Injectable()
export class ChangelogEntryRepository extends Repository<ChangelogEntryEntity, ChangelogEntry> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'changelogEntry', ChangelogEntryEntityMapper.getInstance());
  }
}
