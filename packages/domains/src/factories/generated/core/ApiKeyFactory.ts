/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ApiKeyEntity, IApiKeyEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateApiKeyProps extends BaseEntityFactoryCreateProps {
    keyName: IApiKeyEntity['keyName'];
    keyHash: IApiKeyEntity['keyHash'];
    keyPrefix: IApiKeyEntity['keyPrefix'];
    keyChecksum?: IApiKeyEntity['keyChecksum'];
    keyType: IApiKeyEntity['keyType'];
    keyStatus: IApiKeyEntity['keyStatus'];
    scopes?: IApiKeyEntity['scopes'];
    allowedIps?: IApiKeyEntity['allowedIps'];
    rateLimit?: IApiKeyEntity['rateLimit'];
    expiresAt?: IApiKeyEntity['expiresAt'];
    lastUsedAt?: IApiKeyEntity['lastUsedAt'];
    usageCount: IApiKeyEntity['usageCount'];
    rotatedFromKeyId?: IApiKeyEntity['rotatedFromKeyId'];
    rotatedToKeyId?: IApiKeyEntity['rotatedToKeyId'];
    rotationExpiresAt?: IApiKeyEntity['rotationExpiresAt'];
    originalCreatorId?: IApiKeyEntity['originalCreatorId'];
    description?: IApiKeyEntity['description'];
    environment?: IApiKeyEntity['environment'];
    userId?: IApiKeyEntity['userId'];
    tenantId?: IApiKeyEntity['tenantId'];
    Tenant?: IApiKeyEntity['Tenant'];

    createdAt?: IApiKeyEntity['createdAt'];
    updatedAt?: IApiKeyEntity['updatedAt'];
    createdBy?: IApiKeyEntity['createdBy'];
    updatedBy?: IApiKeyEntity['updatedBy'];
}

export class ApiKeyFactory {
    static CreateApiKey(props: CreateApiKeyProps): ApiKeyEntity {
        const id = generateId();
        const now = new Date();

        return new ApiKeyEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            keyName: props.keyName,
            keyHash: props.keyHash,
            keyPrefix: props.keyPrefix,
            keyChecksum: props.keyChecksum ?? null,
            keyType: props.keyType,
            keyStatus: props.keyStatus,
            scopes: props.scopes ?? null,
            allowedIps: props.allowedIps ?? null,
            rateLimit: props.rateLimit ?? 0,
            expiresAt: props.expiresAt ?? null,
            lastUsedAt: props.lastUsedAt ?? null,
            usageCount: props.usageCount,
            rotatedFromKeyId: props.rotatedFromKeyId ?? null,
            rotatedToKeyId: props.rotatedToKeyId ?? null,
            rotationExpiresAt: props.rotationExpiresAt ?? null,
            originalCreatorId: props.originalCreatorId ?? null,
            description: props.description ?? null,
            environment: props.environment ?? null,
            userId: props.userId ?? null,
            tenantId: props.tenantId ?? null,
            Tenant: props.Tenant ?? null,
        });
    }
}