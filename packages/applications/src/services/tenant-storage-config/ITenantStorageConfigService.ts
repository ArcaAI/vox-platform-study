import { UpsertPlatformStorageConfigRequest, UpsertTenantStorageConfigRequest, TenantStorageConfigResponse } from './dto';

export abstract class ITenantStorageConfigService {
  /** All storage configs for the active tenant (default + per-bucket overrides). */
  abstract listConfigs(options?: { includeDisabled?: boolean }): Promise<TenantStorageConfigResponse[]>;

  /**
   * The config that actually applies for a bucket: per-bucket override first,
   * then the tenant-wide default, then the SYSTEM platform default. `null` when
   * no tier has a row (the backend then uses the env bootstrap fallback).
   */
  abstract getEffectiveConfig(bucketId?: string): Promise<TenantStorageConfigResponse | null>;

  /** Create or update a config for the active tenant (keyed by bucketId, null = default). */
  abstract upsertConfig(dto: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigResponse>;

  /** Soft-delete a config (reverts that scope to the next-broader config / global). */
  abstract deleteConfig(id: string): Promise<TenantStorageConfigResponse>;

  /**
   * The PLATFORM default — the SYSTEM-tenant row every tenant falls back to.
   * GLOBAL_ADMIN only (403 otherwise). Returns a `version: 0` placeholder when
   * the row has not been created yet.
   */
  abstract getPlatformDefault(): Promise<TenantStorageConfigResponse>;

  /**
   * Create (`expectedVersion: 0`) or CAS-update the platform default under
   * optimistic concurrency. GLOBAL_ADMIN only (403 otherwise).
   */
  abstract upsertPlatformDefault(dto: UpsertPlatformStorageConfigRequest): Promise<TenantStorageConfigResponse>;
}
