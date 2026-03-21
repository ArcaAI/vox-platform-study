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
}

function generateAccessKeyId(): string {
    return 'HOPE' + randomBytes(12).toString('hex').toUpperCase();
}

function generateSecretKey(): string {
    return randomBytes(32).toString('base64url');
}

export class StorageAccessKeyFactory {
    static CreateKey(props: CreateStorageAccessKeyProps): StorageAccessKeyEntity {
        return new StorageAccessKeyEntity({
            id: generateId(),
            tenantId: props.tenantId,
            name: props.name,
            description: props.description ?? null,
            accessKeyId: generateAccessKeyId(),
            secretAccessKey: generateSecretKey(),
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
