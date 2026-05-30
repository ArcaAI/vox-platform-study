import { randomBytes } from 'crypto';
import { generateId } from '../../../utils';
import { StorageAccessKeyEntity } from '../../../entities/generated/core/StorageAccessKeyEntity';

export interface CreateStorageAccessKeyProps {
  tenantId: string;
  name: string;
  description?: string;
  permissions?: string[];
  bucketIds?: string[];
  expiresAt?: Date;
  createdBy?: string;
  /**
   * TASK-318 W3 (F-2) — the HASH of the secret access key, never the plaintext.
   * The application layer (`StorageAccessKeyService`) generates the raw secret
   * via {@link StorageAccessKeyFactory.generateRawSecret}, hashes it (peppered
   * when a SecretsService is available), and passes the digest here so only the
   * hash is ever persisted.
   */
  secretAccessKey: string;
}

function generateAccessKeyId(): string {
  return 'HOPE' + randomBytes(12).toString('hex').toUpperCase();
}

export class StorageAccessKeyFactory {
  /**
   * TASK-318 W3 (F-2) — generate a cryptographically-secure raw secret
   * (plaintext). 32 random bytes encoded as base64url => 43 url-safe chars.
   * This value is shown to the caller exactly once at creation time; the
   * database stores only its hash (computed by the service), so a leaked row
   * can never reveal a usable secret.
   */
  static generateRawSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  static CreateKey(props: CreateStorageAccessKeyProps): StorageAccessKeyEntity {
    return new StorageAccessKeyEntity({
      id: generateId(),
      tenantId: props.tenantId,
      name: props.name,
      description: props.description ?? null,
      accessKeyId: generateAccessKeyId(),
      secretAccessKey: props.secretAccessKey,
      permissions: props.permissions ?? ['read'],
      bucketIds: props.bucketIds ?? [],
      expiresAt: props.expiresAt ?? null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: props.createdBy ?? null,
      updatedBy: null,
    });
  }
}
