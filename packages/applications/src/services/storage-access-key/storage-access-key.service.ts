import { Injectable, BadRequestException, NotFoundException, Logger, Inject, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, createHmac } from 'crypto';
import {
  StorageAccessKeyRepository,
  TenantBucketRepository,
  StorageAccessKeyFactory,
  StorageAccessKeyEntity,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { IStorageAccessKeyService } from './IStorageAccessKeyService';
import { StorageAccessKeyResponse, StorageAccessKeyWithSecretResponse, CreateStorageAccessKeyRequest } from './dto';
import { StorageAccessKeyDtoMapper } from './storage-access-key.dto.mapper';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import {
  DEFAULT_GENERATED_SECRET_POLICY,
  GeneratedSecretPolicy,
  STORAGE_ACCESS_KEY_ENCODING,
  generateSecretString,
  resolveGeneratedSecretPolicy,
} from '../security/secretPolicy';

@Injectable()
export class StorageAccessKeyService extends BaseService implements IStorageAccessKeyService {
  private readonly logger = new Logger(StorageAccessKeyService.name);

  constructor(
    private readonly storageAccessKeyRepository: StorageAccessKeyRepository,
    private readonly tenantBucketRepository: TenantBucketRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Pepper source for hashing the secret access key.
    // Optional so legacy/direct-construction tests still work (they fall back
    // to un-peppered SHA-256), mirroring ApiKeyService.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // The platform `security.secret.*` policy behind an issued secret access
    // key. Optional (append-only DI) so fixtures that construct this service
    // directly keep the pre-policy 32-byte base64url behaviour exactly as it was.
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.StorageAccessKey);
  }

  /**
   * The SUPER_ADMIN-managed `security.secret.*` policy, or the platform
   * defaults when no settings cache is wired (legacy fixtures).
   */
  private secretPolicy(): GeneratedSecretPolicy {
    return this.appSettings ? resolveGeneratedSecretPolicy(this.appSettings) : DEFAULT_GENERATED_SECRET_POLICY;
  }

  /**
   * CSPRNG material for one secret access key, drawn to the CONFIGURED
   * `byteLength` and PINNED to base64url (`STORAGE_ACCESS_KEY_ENCODING`) —
   * the shipped S3-style shape, 32 bytes as 43 url-safe characters.
   *
   * Generation moved OUT of `StorageAccessKeyFactory.generateRawSecret()` for
   * this: a domain factory is DI-free by the layer contract, so it can never
   * reach the settings cache and would have kept issuing a hardcoded 32 bytes
   * forever. The factory's static remains for the domain's own tests; the
   * application layer no longer calls it.
   *
   * Policy applies at ISSUANCE only. The stored form is a peppered one-way
   * hash of whatever string this produced, so length may change freely without
   * breaking authentication of keys already issued.
   */
  generateRawSecret(): string {
    return generateSecretString(this.secretPolicy(), STORAGE_ACCESS_KEY_ENCODING);
  }

  /**
   * Hash a raw secret with SHA-256, optionally peppered via HMAC. Pure: the
   * pepper is passed explicitly so callers can compute a digest deterministically.
   */
  static hashSecret(rawSecret: string, pepper?: string): string {
    if (pepper) {
      return createHmac('sha256', pepper).update(rawSecret).digest('hex');
    }
    return createHash('sha256').update(rawSecret).digest('hex');
  }

  /**
   * Resolve the pepper and hash a raw secret for storage. Prefers
   * `STORAGE_ACCESS_KEY_PEPPER`, falls back to the shared `API_KEY_PEPPER`,
   * then to un-peppered SHA-256 when no SecretsService / pepper is available.
   */
  async hashSecretForStorage(rawSecret: string): Promise<string> {
    const pepper =
      (await this.secretsService?.getSecretOptional('STORAGE_ACCESS_KEY_PEPPER')) ??
      (await this.secretsService?.getSecretOptional('API_KEY_PEPPER')) ??
      undefined;
    return StorageAccessKeyService.hashSecret(rawSecret, pepper);
  }

  async listKeys(): Promise<StorageAccessKeyResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const keys = await this.storageAccessKeyRepository.findAllByTenant(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: keys.length },
    });

    return keys.map(StorageAccessKeyDtoMapper.toResponse);
  }

  async generateKey(dto: CreateStorageAccessKeyRequest): Promise<StorageAccessKeyWithSecretResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    if (dto.bucketIds && dto.bucketIds.length > 0) {
      for (const bucketId of dto.bucketIds) {
        const bucket = await this.tenantBucketRepository.findById(bucketId);
        if (!bucket || bucket.tenantId !== tenantId) {
          throw new NotFoundException(`Bucket ${bucketId} not found for this tenant`);
        }
      }
    }

    // Generate the raw secret, persist only its hash, and
    // return the plaintext to the caller exactly once. The plaintext is never
    // stored and cannot be retrieved afterwards.
    const rawSecret = this.generateRawSecret();
    const secretHash = await this.hashSecretForStorage(rawSecret);

    const key = StorageAccessKeyFactory.CreateKey({
      tenantId,
      name: dto.name,
      description: dto.description,
      permissions: dto.permissions,
      bucketIds: dto.bucketIds,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      createdBy: userId ?? undefined,
      secretAccessKey: secretHash,
    });

    const saved = await this.storageAccessKeyRepository.create(key);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { name: dto.name, permissions: dto.permissions },
    });

    return StorageAccessKeyDtoMapper.toResponseWithSecret(saved, rawSecret);
  }

  async revokeKey(id: string): Promise<StorageAccessKeyResponse> {
    const key = await this.storageAccessKeyRepository.findById(id);
    if (!key) {
      throw new NotFoundException(`Storage access key ${id} not found`);
    }

    const deleted = await this.storageAccessKeyRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { name: deleted.name, accessKeyId: deleted.accessKeyId },
    });

    return StorageAccessKeyDtoMapper.toResponse(deleted);
  }

  async validateKey(accessKeyId: string, ipAddress?: string): Promise<{ tenantId: string; permissions: string[]; bucketIds: string[] } | null> {
    const key = await this.storageAccessKeyRepository.findByAccessKeyId(accessKeyId);
    if (!key) return null;
    if (key.isExpired) return null;

    // Record last-used metadata on each successful
    // validation. Fire-and-forget so a metadata write failure never blocks the
    // auth path.
    void this.recordUsage(key, ipAddress);

    return {
      tenantId: key.tenantId as string,
      permissions: key.permissions,
      bucketIds: key.bucketIds,
    };
  }

  /**
   * Stamp `lastUsedAt`/`lastUsedIp` on a validated key.
   * Errors are swallowed (logged) because usage tracking must never fail an
   * otherwise-valid authentication.
   */
  private async recordUsage(key: StorageAccessKeyEntity, ipAddress?: string): Promise<void> {
    try {
      key.lastUsedAt = new Date();
      if (ipAddress !== undefined) {
        key.lastUsedIp = ipAddress;
      }
      await this.storageAccessKeyRepository.update(key.id, key);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to record storage access key usage',
        keyId: key.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
