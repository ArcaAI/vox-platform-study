import { IBaseService } from '../../../interfaces';
import { ProvisionTenantWithAdminInput } from './dto';
import { TenantProvisionResult } from './tenantOnboarding.dto.mapper';

/**
 * The shared "spin-up" orchestration used by BOTH self-service
 * registration (D6 SYSTEM bootstrap) and super-admin create-tenant: creates
 * the tenant (via `ITenantService.create`, which already provisions buckets,
 * cloned settings, the GEN department, and catalogs), resolves/creates the
 * admin user, assigns them `TENANT_ADMIN`, and attaches them to the GEN
 * department — atomically enough that a tenant is never left adminless
 * (compensating soft-delete rollback on failure; see the service for the
 * exact guarantee).
 */
export interface ITenantOnboardingService extends IBaseService {
  provisionTenantWithAdmin(input: ProvisionTenantWithAdminInput): Promise<TenantProvisionResult>;
}
export const ITenantOnboardingService = Symbol('ITenantOnboardingService');
