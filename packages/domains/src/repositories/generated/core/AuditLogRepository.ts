import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AuditLogEntityMapper } from '../../../mappers';
import { AuditLogEntity } from '../../../entities';
import { AuditLog } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class AuditLogRepository extends Repository<AuditLogEntity, AuditLog> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'auditLog', AuditLogEntityMapper.getInstance(), undefined, ['eventType', 'resourceId', 'correlationId']);
  }
}
