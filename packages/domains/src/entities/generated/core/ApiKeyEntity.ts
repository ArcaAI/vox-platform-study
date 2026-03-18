/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IApiKeyEntity extends IBaseTenantEntity {
    keyName: string;
    keyHash: string;
    keyPrefix: string;
    keyChecksum?: string | null;
    keyType: Enums.ApiKeyType;
    keyStatus: Enums.ApiKeyStatus;
    scopes?: JsonValue | null;
    allowedIps?: JsonValue | null;
    rateLimit?: number | null;
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
    usageCount: number;
    rotatedFromKeyId?: string | null;
    rotatedToKeyId?: string | null;
    rotationExpiresAt?: Date | null;
    originalCreatorId?: string | null;
    description?: string | null;
    environment?: string | null;
    userId?: string | null;
}

export class ApiKeyEntity extends BaseTenantEntity {
    private _keyName: IApiKeyEntity['keyName'];
    private _keyHash: IApiKeyEntity['keyHash'];
    private _keyPrefix: IApiKeyEntity['keyPrefix'];
    private _keyChecksum?: IApiKeyEntity['keyChecksum'];
    private _keyType: IApiKeyEntity['keyType'];
    private _keyStatus: IApiKeyEntity['keyStatus'];
    private _scopes?: IApiKeyEntity['scopes'];
    private _allowedIps?: IApiKeyEntity['allowedIps'];
    private _rateLimit?: IApiKeyEntity['rateLimit'];
    private _expiresAt?: IApiKeyEntity['expiresAt'];
    private _lastUsedAt?: IApiKeyEntity['lastUsedAt'];
    private _usageCount: IApiKeyEntity['usageCount'];
    private _rotatedFromKeyId?: IApiKeyEntity['rotatedFromKeyId'];
    private _rotatedToKeyId?: IApiKeyEntity['rotatedToKeyId'];
    private _rotationExpiresAt?: IApiKeyEntity['rotationExpiresAt'];
    private _originalCreatorId?: IApiKeyEntity['originalCreatorId'];
    private _description?: IApiKeyEntity['description'];
    private _environment?: IApiKeyEntity['environment'];
    private _userId?: IApiKeyEntity['userId'];

    constructor(init: IApiKeyEntity) {
        super(init);
        this._keyName = init.keyName;
        this._keyHash = init.keyHash;
        this._keyPrefix = init.keyPrefix;
        this._keyChecksum = init.keyChecksum;
        this._keyType = init.keyType;
        this._keyStatus = init.keyStatus;
        this._scopes = init.scopes;
        this._allowedIps = init.allowedIps;
        this._rateLimit = init.rateLimit;
        this._expiresAt = init.expiresAt;
        this._lastUsedAt = init.lastUsedAt;
        this._usageCount = init.usageCount;
        this._rotatedFromKeyId = init.rotatedFromKeyId;
        this._rotatedToKeyId = init.rotatedToKeyId;
        this._rotationExpiresAt = init.rotationExpiresAt;
        this._originalCreatorId = init.originalCreatorId;
        this._description = init.description;
        this._environment = init.environment;
        this._userId = init.userId;
    }

    get keyName(): IApiKeyEntity['keyName'] {
        return this._keyName;
    }

    set keyName(value: IApiKeyEntity['keyName']) {
        this.setProperty('keyName', value);
    }

    get keyHash(): IApiKeyEntity['keyHash'] {
        return this._keyHash;
    }

    set keyHash(value: IApiKeyEntity['keyHash']) {
        this.setProperty('keyHash', value);
    }

    get keyPrefix(): IApiKeyEntity['keyPrefix'] {
        return this._keyPrefix;
    }

    set keyPrefix(value: IApiKeyEntity['keyPrefix']) {
        this.setProperty('keyPrefix', value);
    }

    get keyChecksum(): IApiKeyEntity['keyChecksum'] {
        return this._keyChecksum;
    }

    set keyChecksum(value: IApiKeyEntity['keyChecksum']) {
        this.setProperty('keyChecksum', value);
    }

    get keyType(): IApiKeyEntity['keyType'] {
        return this._keyType;
    }

    set keyType(value: IApiKeyEntity['keyType']) {
        this.setProperty('keyType', value);
    }

    get keyStatus(): IApiKeyEntity['keyStatus'] {
        return this._keyStatus;
    }

    set keyStatus(value: IApiKeyEntity['keyStatus']) {
        this.setProperty('keyStatus', value);
    }

    get scopes(): IApiKeyEntity['scopes'] {
        return this._scopes;
    }

    set scopes(value: IApiKeyEntity['scopes']) {
        this.setProperty('scopes', value);
    }

    get allowedIps(): IApiKeyEntity['allowedIps'] {
        return this._allowedIps;
    }

    set allowedIps(value: IApiKeyEntity['allowedIps']) {
        this.setProperty('allowedIps', value);
    }

    get rateLimit(): IApiKeyEntity['rateLimit'] {
        return this._rateLimit;
    }

    set rateLimit(value: IApiKeyEntity['rateLimit']) {
        this.setProperty('rateLimit', value);
    }

    get expiresAt(): IApiKeyEntity['expiresAt'] {
        return this._expiresAt;
    }

    set expiresAt(value: IApiKeyEntity['expiresAt']) {
        this.setProperty('expiresAt', value);
    }

    get lastUsedAt(): IApiKeyEntity['lastUsedAt'] {
        return this._lastUsedAt;
    }

    set lastUsedAt(value: IApiKeyEntity['lastUsedAt']) {
        this.setProperty('lastUsedAt', value);
    }

    get usageCount(): IApiKeyEntity['usageCount'] {
        return this._usageCount;
    }

    set usageCount(value: IApiKeyEntity['usageCount']) {
        this.setProperty('usageCount', value);
    }

    get rotatedFromKeyId(): IApiKeyEntity['rotatedFromKeyId'] {
        return this._rotatedFromKeyId;
    }

    set rotatedFromKeyId(value: IApiKeyEntity['rotatedFromKeyId']) {
        this.setProperty('rotatedFromKeyId', value);
    }

    get rotatedToKeyId(): IApiKeyEntity['rotatedToKeyId'] {
        return this._rotatedToKeyId;
    }

    set rotatedToKeyId(value: IApiKeyEntity['rotatedToKeyId']) {
        this.setProperty('rotatedToKeyId', value);
    }

    get rotationExpiresAt(): IApiKeyEntity['rotationExpiresAt'] {
        return this._rotationExpiresAt;
    }

    set rotationExpiresAt(value: IApiKeyEntity['rotationExpiresAt']) {
        this.setProperty('rotationExpiresAt', value);
    }

    get originalCreatorId(): IApiKeyEntity['originalCreatorId'] {
        return this._originalCreatorId;
    }

    set originalCreatorId(value: IApiKeyEntity['originalCreatorId']) {
        this.setProperty('originalCreatorId', value);
    }

    get description(): IApiKeyEntity['description'] {
        return this._description;
    }

    set description(value: IApiKeyEntity['description']) {
        this.setProperty('description', value);
    }

    get environment(): IApiKeyEntity['environment'] {
        return this._environment;
    }

    set environment(value: IApiKeyEntity['environment']) {
        this.setProperty('environment', value);
    }

    get userId(): IApiKeyEntity['userId'] {
        return this._userId;
    }

    set userId(value: IApiKeyEntity['userId']) {
        this.setProperty('userId', value);
    }

    public override validate(): void {
        if (!this._keyName || this._keyName.trim().length === 0) {
            throw new BusinessException('API key name is required.');
        }
        if (this._keyName.length > 255) {
            throw new BusinessException('API key name must not exceed 255 characters.');
        }
        if (!this._keyHash || this._keyHash.trim().length === 0) {
            throw new BusinessException('API key hash is required.');
        }
        if (!this._keyPrefix || this._keyPrefix.trim().length === 0) {
            throw new BusinessException('API key prefix is required.');
        }
        if (!this._keyType) {
            throw new BusinessException('API key type is required.');
        }
        if (!this._keyStatus) {
            throw new BusinessException('API key status is required.');
        }
        if (this._rateLimit !== undefined && this._rateLimit !== null && this._rateLimit < 0) {
            throw new BusinessException('Rate limit must be a non-negative number.');
        }
        if (this._expiresAt && this._expiresAt < this.createdAt) {
            throw new BusinessException('Expiration date must be after the creation date.');
        }
        if (this._description && this._description.length > 1000) {
            throw new BusinessException('Description must not exceed 1000 characters.');
        }
    }
}