import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantGuardrailPolicyEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantGuardrailPolicyEntityMapper } from '../../../mappers';
import { TenantGuardrailPolicy } from '../../../models';

@Injectable()
export class TenantGuardrailPolicyRepository extends Repository<TenantGuardrailPolicyEntity, TenantGuardrailPolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantGuardrailPolicy', TenantGuardrailPolicyEntityMapper.getInstance());
  }

  /**
   * The single availability row for a tenant (`tenantId` is unique), or null
   * when the tenant has no row — which is the DECLARED way a tenant inherits
   * the SYSTEM set, not an error. Passing the SYSTEM tenant id returns the
   * platform default row.
   */
  async findByTenantId(tenantId: string): Promise<TenantGuardrailPolicyEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      });
    } catch {
      return null;
    }
  }
}
