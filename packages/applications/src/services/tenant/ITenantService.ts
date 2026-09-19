import { EntityId, GlobalSettingEntity, TenantEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';
import { CreateTenantRequest, UpdateTenantRequest } from './dto';
import { UpdateTenantConfigRequest } from './dto/updateTenantConfigRequest';

export interface ITenantService extends IBaseService {
  // Tenant basics

  // Create
  create(request: CreateTenantRequest): Promise<TenantEntity>;
  // queries
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<TenantEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<TenantEntity>>;
  fetchById(id: EntityId): Promise<TenantEntity>;
  fetchByCodeName(codeName: string): Promise<TenantEntity>;
  // updates
  update(id: EntityId, request: UpdateTenantRequest): Promise<TenantEntity>;
  // deletes
  deleteById(id: EntityId): Promise<TenantEntity>;

  /**
   * W2-8 — compensating rollback for `TenantOnboardingService`: HARD-deletes
   * a tenant that failed provisioning before an admin was ever attached,
   * plus every row `create()` wrote for it (reference-set clone, ASR
   * pipeline catalog, department catalog). NOT a general-purpose delete —
   * `deleteById` (soft delete) remains the only path for a real, live
   * tenant.
   */
  purgeFailedProvisioning(tenantId: EntityId): Promise<void>;

  // Lifecycle. Dedicated non-OCC operator transitions.
  // `suspend`/`archive` are blocked on the system tenant (DEF-ADM-002).
  suspend(id: EntityId): Promise<TenantEntity>;
  archive(id: EntityId): Promise<TenantEntity>;
  restore(id: EntityId): Promise<TenantEntity>;

  // Tags. Replaces the tenant's full tag set.
  setTags(id: EntityId, tags: string[], expectedVersion?: number): Promise<TenantEntity>;

  // Tenant configurations
  fetchTenantConfigs(props: PaginatedQuery & { tenantId?: string; codeName?: string }): Promise<FetchResponse<GlobalSettingEntity>>;
  updateTenantConfigs(identifier: EntityId | string, configs: UpdateTenantConfigRequest[]): Promise<FetchResponse<GlobalSettingEntity>>;

  // Tenant usage statistics — extended with storage + clinical metrics
  getUsageStats(tenantId: EntityId): Promise<{
    totalUsers: number;
    totalDepartments: number;
    totalPromptTemplates: number;
    totalPipelines: number;
    storageUsedBytes: number;
    storageQuotaBytes: number | null;
    transcriptionMinutes: number;
    summaries24h: number;
    totalConsultations: number;
  }>;
}
export const ITenantService = Symbol('ITenantService');
