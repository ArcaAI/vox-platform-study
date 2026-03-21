import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    StorageAccessKeyRepository,
    TenantBucketRepository,
    StorageAccessKeyFactory,
    ResourceType,
    SysEventType,
} from '@arcaai/domains';
import { IStorageAccessKeyService } from './IStorageAccessKeyService';
import {
    StorageAccessKeyResponse,
    StorageAccessKeyWithSecretResponse,
    CreateStorageAccessKeyRequest,
} from './dto';
import { StorageAccessKeyDtoMapper } from './storage-access-key.dto.mapper';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

@Injectable()
export class StorageAccessKeyService extends BaseService implements IStorageAccessKeyService {
    private readonly logger = new Logger(StorageAccessKeyService.name);

    constructor(
        private readonly storageAccessKeyRepository: StorageAccessKeyRepository,
        private readonly tenantBucketRepository: TenantBucketRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>,
    ) {
        super(eventEmitter, clsService, ResourceType.StorageAccessKey);
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

        const key = StorageAccessKeyFactory.CreateKey({
            tenantId,
            name: dto.name,
            description: dto.description,
            permissions: dto.permissions,
            bucketIds: dto.bucketIds,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
            createdBy: userId ?? undefined,
        });

        const saved = await this.storageAccessKeyRepository.create(key);

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
            resourceId: saved.id,
            createdAt: saved.createdAt,
            data: { name: dto.name, permissions: dto.permissions },
        });

        return StorageAccessKeyDtoMapper.toResponseWithSecret(saved);
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

    async validateKey(accessKeyId: string): Promise<{ tenantId: string; permissions: string[]; bucketIds: string[] } | null> {
        const key = await this.storageAccessKeyRepository.findByAccessKeyId(accessKeyId);
        if (!key) return null;
        if (key.isExpired) return null;

        return {
            tenantId: key.tenantId as string,
            permissions: key.permissions,
            bucketIds: key.bucketIds,
        };
    }
}
