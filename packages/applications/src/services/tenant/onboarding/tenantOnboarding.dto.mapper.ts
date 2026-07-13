import { TenantEntity } from '@arcaai/domains';
import { TenantDtoMapper } from '../tenant.dto.mapper';
import { TenantProvisionResponse } from './dto';

export interface TenantProvisionResult {
  tenant: TenantEntity;
  adminUserId: string;
  tenantKey: string;
}

export class TenantOnboardingDtoMapper {
  static ToResponse(result: TenantProvisionResult): TenantProvisionResponse {
    return new TenantProvisionResponse({
      tenant: TenantDtoMapper.ToResponse(result.tenant),
      adminUserId: result.adminUserId,
      tenantKey: result.tenantKey,
    });
  }
}
