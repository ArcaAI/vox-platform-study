import { UpsertTenantStorageConfigRequest, TenantStorageConfigResponse } from './dto';

export abstract class ITenantStorageConfigService {
  /** All storage configs for the active tenant (default + per-bucket overrides). */
  abstract listConfigs(options?: { includeDisabled?: boolean }): Promise<TenantStorageConfigResponse[]>;

  /**
   * The config that actually applies for a bucket: per-bucket override first,
   * else the tenant-wide default. `null` when the tenant has none (the backend
   * then uses the global/shared provider).
   */
  abstract getEffectiveConfig(bucketId?: string): Promise<TenantStorageConfigResponse | null>;

  /** Create or update a config for the active tenant (keyed by bucketId, null = default). */
  abstract upsertConfig(dto: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigResponse>;

  /** Soft-delete a config (reverts that scope to the next-broader config / global). */
  abstract deleteConfig(id: string): Promise<TenantStorageConfigResponse>;
}
