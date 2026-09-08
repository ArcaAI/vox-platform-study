/**
 * TASK-932 D-7 — the weight store's BUILT-IN default: the platform's own object
 * storage.
 *
 * WHAT WAS WRONG. `model-registry:s3` seeded blank and DISABLED, so the console
 * rendered the platform's weight store as "no key · Disabled for this tenant" —
 * tenant wording on a platform row, and a state that says "nobody configured
 * this" about the thing every model fetch depends on. But the platform HAS an
 * object store: MinIO, already configured, already holding `hope-models`, whose
 * endpoint and key pair resolve through the storage cascade (SYSTEM
 * `TenantStorageConfig` row → AppSettings `S3_*` → bootstrap `MINIO_*`).
 * Nothing connected the two, so the correct answer was reachable and unused.
 *
 * WHAT THIS DOES. It answers one question — "what credential does the platform's
 * own weight store use?" — by reading the SAME two sources
 * `BlobStorageProviderFactory` reads, in the same order, and nothing else:
 *
 *   1. the non-secret half through `resolvePlatformStorageConfig` (the pure
 *      cascade that module owns — NOT re-implemented here);
 *   2. the secret half through `SecretsService`, from the SYSTEM row's Vault
 *      `credentialsRef` first and the `S3_ACCESS_KEY`/`S3_SECRET_KEY` bootstrap
 *      secrets second — the fallback that keeps a dev box (`SECRETS_PROVIDER=env`,
 *      no Vault kv-v2 entry) working.
 *
 * WHY NOT REUSE `BlobStorageProviderFactory` DIRECTLY. That factory's product is
 * an `IBlobStorageProvider` — a client — and this caller does not want a client:
 * it must hand the ENDPOINT, the ACCESS KEY ID and the SECRET to a Python
 * process that will build its own boto3 client. Extracting the values out of a
 * constructed provider would depend on that class's private shape; reading the
 * two sources it reads depends only on their contracts.
 *
 * WHY IT MAY RETURN `null`. A deployment with no SYSTEM storage row, no
 * AppSettings and no `MINIO_*` has no platform storage — and "no credential" must
 * stay distinguishable from "a credential the caller could not read". The caller
 * maps `null` to the existing `absent` outcome, which for `apps/stt` means "fetch
 * anonymously"; it never invents an empty key pair.
 */

import { Logger } from '@nestjs/common';
import { SYSTEM_TENANT_ID, type TenantStorageConfigRepository } from '@arcaai/domains';
import type { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import type { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { resolvePlatformStorageConfig } from '../tenant-storage-config/platform-storage-config';

/**
 * The `source` a resolved credential carries when the PLATFORM STORAGE cascade
 * supplied it rather than a connection row. Additive on the wire; the existing
 * Python consumer reads only the fields it knows.
 */
export const PLATFORM_STORAGE_CREDENTIAL_SOURCE = 'platform-storage';

/** The three parts a weight fetcher needs, plus which storage tier answered. */
export interface PlatformStorageCredential {
  /** S3/MinIO endpoint URL. Never empty — an endpoint-less result is `null`. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** JSON shape stored at a `credentialsRef`. Mirrors `ResolvedStorageCredentials`. */
interface StorageCredentialsJson {
  accessKeyId?: string;
  secretAccessKey?: string;
}

const logger = new Logger('PlatformStorageCredential');

/**
 * The platform's own object-storage credential, or `null` when this deployment
 * has none. NEVER throws: a fault is reported as `null` by the caller's
 * surrounding try/catch, which already maps a resolve failure to `unavailable`.
 */
export async function resolvePlatformStorageCredential(deps: {
  storageConfigRepository?: TenantStorageConfigRepository | undefined;
  appSettings?: IAppSettingsService | undefined;
  secrets?: SecretsService | undefined;
}): Promise<PlatformStorageCredential | null> {
  const { storageConfigRepository, appSettings, secrets } = deps;

  // The SYSTEM tenant-default row, when the repository is wired. A read failure
  // here is NOT swallowed into "no platform storage": it propagates to the
  // caller, which reports `unavailable` rather than downgrading an entitled
  // fetch to an anonymous one (the same reason `PlatformStorageSettingsResolver`
  // reads through `findAllTenantDefaults`).
  const rows = storageConfigRepository ? await storageConfigRepository.findAllTenantDefaults(SYSTEM_TENANT_ID) : [];

  const config = resolvePlatformStorageConfig({
    systemRow: rows[0] ?? null,
    appSettings: {
      STORAGE_PROVIDER: appSettings?.getValueWithDefault<string>('STORAGE_PROVIDER', '') ?? '',
      S3_ENDPOINT: appSettings?.getValueWithDefault<string>('S3_ENDPOINT', '') ?? '',
      S3_REGION: appSettings?.getValueWithDefault<string>('S3_REGION', '') ?? '',
      S3_FORCE_PATH_STYLE: appSettings?.getValueWithDefault<boolean>('S3_FORCE_PATH_STYLE', true) ?? true,
      AZURE_STORAGE_ACCOUNT: appSettings?.getValueWithDefault<string>('AZURE_STORAGE_ACCOUNT', '') ?? '',
      AZURE_STORAGE_ENDPOINT_SUFFIX: appSettings?.getValueWithDefault<string>('AZURE_STORAGE_ENDPOINT_SUFFIX', '') ?? '',
    },
    env: process.env,
  });

  const endpoint = config.endpoint.trim();
  if (!endpoint) {
    // `''` is how the cascade spells "no tier answered" for the endpoint (real
    // AWS S3 uses the SDK default). A weight fetcher in another process cannot
    // act on "the SDK default", so this is genuinely no answer.
    return null;
  }

  const credentials = await loadCredentials(secrets, config.credentialsRef);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) return null;

  return {
    endpoint,
    region: config.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  };
}

/**
 * The Vault `credentialsRef` first, the bootstrap `S3_*` secrets second — the
 * order and the fallback are `BlobStorageProviderFactory.loadPlatformCredentials`'s,
 * kept identical so the weight fetcher authenticates as the same principal the
 * gateway's own uploads do.
 */
async function loadCredentials(secrets: SecretsService | undefined, credentialsRef: string | null): Promise<StorageCredentialsJson> {
  if (!secrets) return {};

  if (credentialsRef) {
    const raw = await secrets.getSecretOptional(credentialsRef);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StorageCredentialsJson;
        if (parsed.accessKeyId || parsed.secretAccessKey) return parsed;
      } catch {
        // Names the REF, never the value — a malformed secret body can carry the
        // material it failed to parse.
        logger.warn(`Platform storage credentialsRef '${credentialsRef}' is not valid JSON; falling back to the bootstrap secrets`);
      }
    }
  }

  return {
    accessKeyId: (await secrets.getSecretOptional('S3_ACCESS_KEY')) ?? '',
    secretAccessKey: (await secrets.getSecretOptional('S3_SECRET_KEY')) ?? '',
  };
}
