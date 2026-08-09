import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ServiceReleaseEntity } from '../../../entities';
import { ServiceReleaseEntityMapper } from '../../../mappers';
import { ServiceRelease } from '../../../models';

/**
 * Immutable build-facts repository (TASK-648) — one row per
 * (serviceName, gitCommitSha, releaseTag), enforced by
 * `ServiceRelease_service_commit_tag_unique`. Always the SYSTEM tenant.
 */
@Injectable()
export class ServiceReleaseRepository extends Repository<ServiceReleaseEntity, ServiceRelease> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'serviceRelease', ServiceReleaseEntityMapper.getInstance());
  }
}
