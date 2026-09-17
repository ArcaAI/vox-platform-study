// lane A.1 — the `db-config` READ lane for `storage.platformDefault.*`.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
// It is a DISPATCH adapter: it answers "what is the effective value of
// `storage.platformDefault.<field>`?" by reading the row that already holds it
// and folding it through the SAME pure cascade the upload path uses
// (`resolvePlatformStorageConfig`). It is NOT a new store, NOT a second copy of
// the cascade, and NOT a place to add fields — a value that has no home on
// `TenantStorageConfig` does not belong here (D-2: never invent a third home).
//
// This mirrors how `models.*` resolved: `EffectiveSettingsService` delegated to
// `AiTaskDefaultService` rather than re-implementing data access, because the
// service that owns the table owns the semantics.
//
// THREE PROPERTIES ARE LOAD-BEARING.
//
// 1. **A backend error PROPAGATES.** The row is read through
//    `findAllTenantDefaults`, NOT `findSystemDefault`: the latter swallows
//    lookup errors and returns `null`, which is the right posture for an upload
//    (a DB hiccup degrades to the env tier rather than taking uploads down) and
//    the WRONG one for a config read (an unreachable database would become
//    "the platform has no opinion", and every caller would silently receive the
//    descriptor default). `findAllTenantDefaults` reads the same rows —
//    `tenantId = SYSTEM`, `bucketId IS NULL`, `ENABLED` — and lets the error out.
//
// 2. **Absence is reported as `undefined`, never as a substituted default.**
//    Applying the declared `failMode` is the caller's job and happens in exactly
//    one place (`applyFailMode`). A resolver that substituted here would make
//    `failMode: 'closed'` unenforceable.
//
// 3. **The credentials pointer is not claimed.** `storage.platformDefault.credentials`
//    shares the prefix but is `vault-kv` / `sensitivity: 'secret'` — the Vault
//    `credentialsRef`, which must never traverse a config read surface. The
//    facade refuses secrets before dispatch; not claiming the key here is the belt.
//
// SCOPE NOTE (rule 09 §Tenant-first resolution). These keys are
// `maxScope: 'system'` + `globalOnly: true`: the platform default every tenant
// inherits. There is deliberately no tenant tier in this cascade — a tenant
// tunes its OWN `TenantStorageConfig` row instead of overriding the platform
// one, so resolving the SYSTEM row regardless of the caller's tenant is the
// documented super-admin-only exception, not a cross-tenant read.

import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID, TenantStorageConfigRepository, type TenantStorageConfigEntity } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { PlatformStorageConfig, PlatformStorageSource, resolvePlatformStorageConfig } from './platform-storage-config';

/** Which cascade tier answered, in the vocabulary `EffectiveSettingResult.sourceScope` uses. */
export type PlatformStorageSettingScope = 'system' | 'app-settings' | 'env-bootstrap';

export interface ResolvedPlatformStorageSetting {
  value: unknown;
  sourceScope: PlatformStorageSettingScope;
}

/**
 * Registry key → the `PlatformStorageConfig` field that answers it.
 *
 * An explicit table rather than a prefix test, so `storage.platformDefault.credentials`
 * (the Vault pointer) cannot be picked up by accident, and so adding a key is a
 * deliberate edit rather than an emergent behaviour of the naming scheme.
 */
const KEY_TO_FIELD = {
  'storage.platformDefault.provider': 'provider',
  'storage.platformDefault.endpoint': 'endpoint',
  'storage.platformDefault.publicEndpoint': 'publicEndpoint',
  'storage.platformDefault.region': 'region',
  'storage.platformDefault.forcePathStyle': 'forcePathStyle',
  'storage.platformDefault.containerPrefix': 'containerPrefix',
} as const satisfies Record<string, keyof PlatformStorageConfig>;

type ResolvableKey = keyof typeof KEY_TO_FIELD;

const SOURCE_SCOPE: Record<PlatformStorageSource, PlatformStorageSettingScope> = {
  'system-row': 'system',
  'app-settings': 'app-settings',
  env: 'env-bootstrap',
};

@Injectable()
export class PlatformStorageSettingsResolver {
  constructor(
    private readonly configRepository: TenantStorageConfigRepository,
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
  ) {}

  /** True when this resolver owns `key`. Drives the facade's dispatch. */
  resolves(key: string): key is ResolvableKey {
    return key in KEY_TO_FIELD;
  }

  /**
   * The effective value for one key, or `undefined` when no tier supplied one.
   *
   * Throws whatever the repository throws — see property 1 above.
   */
  async resolve(key: string): Promise<ResolvedPlatformStorageSetting | undefined> {
    if (!this.resolves(key)) return undefined;

    const config = await this.resolvePlatformConfig();
    const raw = config[KEY_TO_FIELD[key]];

    // `''` and `null` are how the cascade spells "no answer at any tier" for the
    // optional fields (endpoint, containerPrefix). Reporting them as VALUES
    // would make "unset" indistinguishable from "deliberately empty", and the
    // caller could no longer apply the declared failMode.
    if (raw === null || raw === undefined || raw === '') return undefined;

    // The provider enum is stored in the Prisma spelling (`MINIO`) but the
    // DESCRIPTOR declares the wire vocabulary (`minio | aws_s3 | azure_blob`),
    // which is also what every Python consumer's `Literal` expects. Normalising
    // here keeps the translation in ONE place instead of in each consumer.
    const value = KEY_TO_FIELD[key] === 'provider' ? String(raw).toLowerCase() : raw;

    return { value, sourceScope: SOURCE_SCOPE[config.source] };
  }

  private async resolvePlatformConfig(): Promise<PlatformStorageConfig> {
    const rows: TenantStorageConfigEntity[] = await this.configRepository.findAllTenantDefaults(SYSTEM_TENANT_ID);

    return resolvePlatformStorageConfig({
      // At most one ENABLED tenant-wide row exists per tenant (the invariant
      // `findAllTenantDefaults` exists to let the application layer enforce);
      // taking the first mirrors what `findSystemDefault` would have returned.
      systemRow: rows[0] ?? null,
      appSettings: {
        STORAGE_PROVIDER: this.appSettings.getValueWithDefault<string>('STORAGE_PROVIDER', ''),
        S3_ENDPOINT: this.appSettings.getValueWithDefault<string>('S3_ENDPOINT', ''),
        S3_REGION: this.appSettings.getValueWithDefault<string>('S3_REGION', ''),
        S3_FORCE_PATH_STYLE: this.appSettings.getValueWithDefault<boolean>('S3_FORCE_PATH_STYLE', true),
        AZURE_STORAGE_ACCOUNT: this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ACCOUNT', ''),
        AZURE_STORAGE_ENDPOINT_SUFFIX: this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ENDPOINT_SUFFIX', ''),
      },
      env: process.env,
    });
  }
}
