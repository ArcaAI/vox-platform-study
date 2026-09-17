import { TenantStorageConfigEntity } from '../../../entities/generated/core/TenantStorageConfigEntity';
import { StorageProviderType, StorageTopologyType } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateTenantStorageConfigParams {
  tenantId: string;
  provider: StorageProviderType;
  topology?: StorageTopologyType;
  /** null = tenant-wide default; set = per-bucket override. */
  bucketId?: string | null;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  /** Origin presigned URLs are signed for; null = sign with `endpoint`. */
  publicEndpoint?: string | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  /** SecretsService key holding provider credentials (DEDICATED only). */
  credentialsRef?: string | null;
  createdBy?: string | null;
}

export class TenantStorageConfigFactory {
  static CreateConfig(params: CreateTenantStorageConfigParams): TenantStorageConfigEntity {
    return new TenantStorageConfigEntity({
      id: generateId(),
      tenantId: params.tenantId,
      bucketId: params.bucketId ?? null,
      provider: params.provider,
      topology: params.topology ?? StorageTopologyType.SHARED,
      endpoint: params.endpoint ?? null,
      region: params.region ?? null,
      forcePathStyle: params.forcePathStyle ?? null,
      publicEndpoint: params.publicEndpoint || null,
      accountName: params.accountName ?? null,
      endpointSuffix: params.endpointSuffix ?? null,
      containerPrefix: params.containerPrefix ?? null,
      credentialsRef: params.credentialsRef ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: params.createdBy ?? null,
      updatedBy: null,
    });
  }
}
