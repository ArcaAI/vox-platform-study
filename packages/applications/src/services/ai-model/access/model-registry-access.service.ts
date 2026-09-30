import { Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelRegistryAccessResponse } from './model-registry-access.response';
import { isSuperAdmin } from '../../../common/tenant-guards';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY } from '../../settings-registry/descriptors/feature-availability.descriptors';

/**
 * What the caller may do on the model registry — the answer behind
 * `GET admin/ai-models/access`.
 *
 * `canManage` mirrors `assertPlatformRegistryAdmin` exactly (SUPER_ADMIN, no
 * working tenant), so the console never offers a control the write gate refuses.
 *
 * `tenantManagementEnabled` is the effective `modelRegistry.tenantManagement.enabled`
 * for the caller's tenant (SYSTEM for a tenant-less platform admin). It is REPORTED
 * only: it grants a tenant admin no write today. Like every capability gate it
 * fails CLOSED — an unwired facade or a resolution error reports `false`.
 */
@Injectable()
export class ModelRegistryAccessService {
  constructor(
    private readonly clsService: ClsService,
    @Optional() private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  async getAccess(): Promise<ModelRegistryAccessResponse> {
    const user = this.clsService.get('user');
    const workingTenantId: string | null = this.clsService.get('tenantId') || null;
    return {
      canManage: isSuperAdmin(user) && !workingTenantId,
      tenantManagementEnabled: await this.resolveTenantManagementEnabled(workingTenantId ?? SYSTEM_TENANT_ID),
    };
  }

  private async resolveTenantManagementEnabled(tenantId: string): Promise<boolean> {
    if (!this.effectiveSettings) return false;
    try {
      const resolved = await this.effectiveSettings.resolveEffective(MODEL_REGISTRY_TENANT_MANAGEMENT_ENABLED_KEY, { tenantId });
      return resolved.value === true || String(resolved.value) === 'true';
    } catch {
      return false;
    }
  }
}
