# S3 Service — S3-compatible object storage

`IS3Service` / `S3Service` (`@arcaai/applications`), an S3-compatible client (AWS S3, MinIO) whose
non-secret configuration comes from `IAppSettingsService` (the `GlobalSetting` cache) and whose
credentials come from `SecretsService` (Vault-or-env). It is the lower-level client the tenant-aware
blob-storage provider abstraction (`../providers/s3-blob.provider.ts`) builds on; callers name their
own bucket on every call.

## Layout

| Path | What it holds |
|---|---|
| `IS3Service.ts` | The injectable interface: file ops (`putFile`/`getFile`/`listFiles`/`copyFile`/`deleteFile`/`signUrl`), bucket ops (`listAllBuckets`/`createBucket`/`deleteBucket`/`updateBucket`/`setBucketPolicy`), config/health (`isConfigured`/`testConnection`/`refreshConfiguration`/`isMinIOConfigured`/`getMinIOInfo`) |
| `s3.service.ts` | `S3Service` — lazy `S3Client` init, config validation, MinIO detection |
| `s3.service.module.ts` | NestJS module wiring `IS3Service` to `S3Service` |
| `s3.health.service.ts` | Health-check wrapper used by the platform health endpoint |
| `examples/` | `usage-example.ts`, `minio-example.ts` — worked call examples |
| `MINIO.md`, `SETUP.md` | Older MinIO/setup notes — verify against `IS3Service.ts` before relying on them; both still call the retired `getPublicBucketName()`/`getPrivateBucketName()` |

## How it works

### Configuration split: settings vs secrets

Non-secret values are read from `IAppSettingsService` (cache-only reads — `hasSetting`/`getValueFromCache`/`getValueWithDefault`, populated at boot and on `app-settings:invalidate`):
`S3_ENDPOINT`, `S3_REGION` (default `us-east-1`), `S3_FORCE_PATH_STYLE` (default `true`),
`S3_REJECT_UNAUTHORIZED` (default `false`), `S3_PRESIGNED_URL_EXPIRY` (default `3600`),
`S3_MAX_RETRIES` (default `3`), `S3_REQUEST_TIMEOUT` (default `30000`). Credentials are read from
`SecretsService.getSecretSync(...)`, never from `AppSettingsService`: `S3_ACCESS_KEY`,
`S3_SECRET_KEY`. `SecretsService` is `@Optional()` on the constructor so existing direct-construction
unit tests still compile; a missing service resolves credentials to `''`.

### No platform-wide bucket names

`S3_PUBLIC_BUCKET` / `S3_PRIVATE_BUCKET` were retired (TASK-932 OD-8) along with
`getPublicBucketName()`/`getPrivateBucketName()` on `IS3Service`. Every method takes an explicit
`bucketName` — bucket identity is a per-tenant concern (`TenantBucket`, `TenantStorageConfig`), not a
platform-wide default.

### Lazy initialization

`S3Service` implements `OnModuleInit` but tolerates missing configuration at boot: `isConfigured()`
and `testConnection()` let a caller check readiness before an operation, and the client
lazy-initializes (and can be re-initialized with `refreshConfiguration()`) once `AppSettingsService`'s
cache is populated.

## Gotchas

- `hasSetting`/`getValueFromCache` are CACHE-ONLY reads — the cache is populated at boot and on the
  `app-settings:invalidate` event, so a setting written moments ago may not be visible until that
  fires (see `../../_meta/README.md`).
- Do not add a new `S3_*` credential read against `AppSettingsService` — access keys belong on
  `SecretsService`, matching the existing `S3_ACCESS_KEY`/`S3_SECRET_KEY` split.
- `MINIO.md` and `SETUP.md` in this directory predate the bucket-name retirement above and still
  reference `getPublicBucketName()`/`getPrivateBucketName()` — treat their code samples as
  illustrative only until they are updated.

## Related

- [`_meta` README](../../_meta/README.md) — `AppSettingsService` / `SecretsService`
- [`@arcaai/applications` README](../../../../../README.md) — service anatomy
- [`09-infrastructure-devops.md`](../../../../../../../.claude/rules/09-infrastructure-devops.md) — storage config resolution cascade
