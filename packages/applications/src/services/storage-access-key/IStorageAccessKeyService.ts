import { StorageAccessKeyResponse, StorageAccessKeyWithSecretResponse, CreateStorageAccessKeyRequest } from './dto';

export abstract class IStorageAccessKeyService {
  abstract listKeys(): Promise<StorageAccessKeyResponse[]>;
  abstract generateKey(dto: CreateStorageAccessKeyRequest): Promise<StorageAccessKeyWithSecretResponse>;
  abstract revokeKey(id: string): Promise<StorageAccessKeyResponse>;
  abstract validateKey(accessKeyId: string): Promise<{ tenantId: string; permissions: string[]; bucketIds: string[] } | null>;
}
