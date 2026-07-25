// Storage descriptors — the worked example of TASK-558 §3.2: the platform
// object-store configuration moves out of deploy-time env into
// admin-managed data.
//
// Physical home: the SYSTEM-tenant `TenantStorageConfig` row
// (`tenantId = SYSTEM_TENANT_ID`, `bucketId = NULL`). Non-secret fields are
// `db-config`; the MinIO/S3 key PAIR is NOT one of them — it lives in Vault
// kv-v2 at `platform/storage/minio` and is referenced by `credentialsRef`
// (§9.3 M10: per-tenant/platform secrets never sit in a DB column).
//
// Governance: every key here is GLOBAL-ADMIN-ONLY (`globalOnly: true`,
// `editableBy: 'all'`), enforced imperatively by
// `TenantStorageConfigService.assertGlobalAdmin` — the permission decorators
// cannot express "global admins only" (rule 05). `maxScope: 'system'` says the
// value may be set at the SYSTEM scope and nowhere deeper: a tenant tunes its
// own backend through its OWN `TenantStorageConfig` row, not by overriding the
// platform default.
//
// The `MINIO_*` env keys stay declared for one release as the documented
// BOOTSTRAP fallback used before the SYSTEM row exists (first boot / pre-seed);
// they are registered here as `env` tier so the catalog shows the whole story.

import { SettingDescriptor } from '../registry.types';

export const STORAGE_SETTINGS: SettingDescriptor[] = [
  {
    key: 'storage.platformDefault.provider',
    tier: 'db-config',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'Platform storage provider',
    description: 'Object-store backend every tenant falls back to: minio | aws_s3 | azure_blob.',
    default: 'minio',
  },
  {
    key: 'storage.platformDefault.endpoint',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'Platform storage endpoint',
    description: 'S3/MinIO endpoint URL for the platform default. Empty means the SDK default (real AWS S3).',
  },
  {
    key: 'storage.platformDefault.region',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'Platform storage region',
    description: 'S3 region used by the platform default.',
    default: 'us-east-1',
  },
  {
    key: 'storage.platformDefault.forcePathStyle',
    tier: 'db-config',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'Force path-style URLs',
    description: 'Required for MinIO; leave on unless the backend is real AWS S3 with virtual-hosted addressing.',
    default: true,
  },
  {
    key: 'storage.platformDefault.containerPrefix',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'Platform bucket/container prefix',
    description: 'Optional namespace prefix applied to physical bucket/container names.',
  },
  {
    key: 'storage.platformDefault.credentials',
    tier: 'vault-kv',
    dataType: 'secret',
    sensitivity: 'secret',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Credentials',
    label: 'Platform storage credentials (Vault kv-v2)',
    description:
      "Operator-set JSON `{ accessKeyId, secretAccessKey }` at the Vault path recorded in the SYSTEM row's `credentialsRef` " +
      '(default `platform/storage/minio`). Never stored in the database and never returned by any API.',
    default: 'platform/storage/minio',
  },
  {
    key: 'storage.bootstrap.minioEndpoint',
    tier: 'env',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    label: 'MINIO_ENDPOINT (bootstrap fallback)',
    description:
      'Deploy-time fallback used ONLY before the SYSTEM storage row exists (first boot / pre-seed). Scheduled for removal one ' +
      'release after the SYSTEM row ships; a WARN is logged whenever it is the tier that supplied the value.',
  },
];
