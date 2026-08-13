// Platform-default storage configuration — the third and fourth steps of the
// runtime resolution order declared on `TenantStorageConfig`:
//
//   bucket-specific row → tenant default row → SYSTEM default row → env
//
// The first two steps live in `BlobStorageProviderFactory.resolveConfig`. This
// module owns the last two: the SYSTEM-tenant `TenantStorageConfig` row
// (`tenantId = SYSTEM_TENANT_ID`, `bucketId = NULL`) and the BOOTSTRAP env
// fallback used only before that row exists (first boot / pre-seed).
//
// Deliberately a pure function: no DI, no I/O, no logging. The caller supplies
// the already-fetched SYSTEM row, the AppSettings snapshot and `process.env`,
// so the precedence rules are unit-testable in isolation and the caller decides
// how to log the resolved tier (every fallback is observable).
//
// CREDENTIALS ARE NEVER RESOLVED HERE and never live in the database: the
// SYSTEM row carries only a `credentialsRef` (a Vault kv-v2 path), which the
// caller hands to `SecretsService`.

import { StorageProviderType, TenantStorageConfigEntity } from '@arcaai/domains';

/**
 * Vault kv-v2 path holding the platform MinIO/S3 key pair as JSON
 * (`{ "accessKeyId": "...", "secretAccessKey": "..." }`). Seeded onto the
 * SYSTEM row's `credentialsRef`; the value itself is operator-set in Vault.
 */
export const PLATFORM_STORAGE_CREDENTIALS_REF = 'platform/storage/minio';

/** Which tier supplied the resolved platform configuration. */
export type PlatformStorageSource = 'system-row' | 'app-settings' | 'env';

/** Non-secret platform storage configuration, fully resolved. */
export interface PlatformStorageConfig {
  provider: StorageProviderType;
  /** S3/MinIO endpoint URL; `''` means "SDK default" (real AWS S3). */
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  /** Azure storage account name (`''` when not an Azure deployment). */
  accountName: string;
  endpointSuffix: string;
  containerPrefix: string | null;
  /** SecretsService key holding the credentials JSON — never the value. */
  credentialsRef: string | null;
  source: PlatformStorageSource;
}

/** The AppSettings keys the storage tier reads (all non-secret). */
export interface PlatformStorageAppSettings {
  STORAGE_PROVIDER?: string | null;
  S3_ENDPOINT?: string | null;
  S3_REGION?: string | null;
  S3_FORCE_PATH_STYLE?: boolean | null;
  AZURE_STORAGE_ACCOUNT?: string | null;
  AZURE_STORAGE_ENDPOINT_SUFFIX?: string | null;
}

export interface PlatformStorageInputs {
  /** The ENABLED SYSTEM-tenant tenant-default row, when one exists. */
  systemRow: TenantStorageConfigEntity | null | undefined;
  appSettings: PlatformStorageAppSettings;
  /** Raw environment — only `MINIO_*` is consulted, as a bootstrap fallback. */
  env: Record<string, string | undefined>;
}

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_AZURE_ENDPOINT_SUFFIX = 'core.windows.net';

/** Case/whitespace-insensitive `StorageProviderType` parse; `null` when unknown. */
export function normalizeStorageProvider(raw: unknown): StorageProviderType | null {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).trim().toLowerCase();
  switch (normalized) {
    case StorageProviderType.MINIO.toLowerCase():
      return StorageProviderType.MINIO;
    case StorageProviderType.AWS_S3.toLowerCase():
      return StorageProviderType.AWS_S3;
    case StorageProviderType.AZURE_BLOB.toLowerCase():
      return StorageProviderType.AZURE_BLOB;
    default:
      return null;
  }
}

/**
 * Build an endpoint URL from the legacy `MINIO_ENDPOINT` (`host:port`, no
 * scheme) + `MINIO_USE_SSL`. An already-qualified URL passes through.
 * `null` when `MINIO_ENDPOINT` is unset.
 */
export function minioEndpointFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.MINIO_ENDPOINT?.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const scheme = (env.MINIO_USE_SSL ?? 'false').trim().toLowerCase() === 'true' ? 'https' : 'http';
  return `${scheme}://${raw}`;
}

/**
 * Resolve the platform-default storage configuration, most-specific-wins:
 * SYSTEM row → AppSettings `S3_*` → `MINIO_*` env.
 *
 * The SYSTEM row wins WHOLESALE when present (no per-field merge with env):
 * a half-env/half-DB configuration is exactly the drift this refactor removes.
 */
export function resolvePlatformStorageConfig(inputs: PlatformStorageInputs): PlatformStorageConfig {
  const { systemRow, appSettings, env } = inputs;

  if (systemRow) {
    return {
      provider: systemRow.provider,
      endpoint: systemRow.endpoint ?? '',
      region: systemRow.region ?? DEFAULT_REGION,
      forcePathStyle: systemRow.forcePathStyle ?? true,
      accountName: systemRow.accountName ?? '',
      endpointSuffix: systemRow.endpointSuffix ?? DEFAULT_AZURE_ENDPOINT_SUFFIX,
      containerPrefix: systemRow.containerPrefix ?? null,
      credentialsRef: systemRow.credentialsRef ?? null,
      source: 'system-row',
    };
  }

  const provider = normalizeStorageProvider(appSettings.STORAGE_PROVIDER) ?? StorageProviderType.MINIO;
  const settingsEndpoint = appSettings.S3_ENDPOINT?.trim() ?? '';
  const usingAppSettings = settingsEndpoint.length > 0;
  const endpoint = usingAppSettings ? settingsEndpoint : (minioEndpointFromEnv(env) ?? '');

  return {
    provider,
    endpoint,
    region: appSettings.S3_REGION?.trim() || DEFAULT_REGION,
    forcePathStyle: appSettings.S3_FORCE_PATH_STYLE ?? true,
    accountName: appSettings.AZURE_STORAGE_ACCOUNT?.trim() ?? '',
    endpointSuffix: appSettings.AZURE_STORAGE_ENDPOINT_SUFFIX?.trim() || DEFAULT_AZURE_ENDPOINT_SUFFIX,
    containerPrefix: null,
    credentialsRef: null,
    source: usingAppSettings ? 'app-settings' : 'env',
  };
}
