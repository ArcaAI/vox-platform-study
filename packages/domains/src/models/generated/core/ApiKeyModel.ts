/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */


import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ApiKey extends BaseTenantDataModel {
    public keyName: string;
    public keyHash: string;
    public keyPrefix: string;
    public keyChecksum: string | null;
    public keyType: Enums.ApiKeyType;
    public keyStatus: Enums.ApiKeyStatus;
    public scopes: JsonValue | null;
    public allowedIps: JsonValue | null;
    public rateLimit: number | null;
    public expiresAt: Date | null;
    public lastUsedAt: Date | null;
    public usageCount: number;
    public rotatedFromKeyId: string | null;
    public rotatedToKeyId: string | null;
    public rotationExpiresAt: Date | null;
    public originalCreatorId: string | null;
    public description: string | null;
    public environment: string | null;
    public userId: string | null;
    public resourceStatus: Enums.ResourceStatusType;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;

    constructor(data: ApiKey & BaseTenantDataModel) {
        super(data);
        this.keyName = data.keyName;
        this.keyHash = data.keyHash;
        this.keyPrefix = data.keyPrefix;
        this.keyChecksum = data.keyChecksum;
        this.keyType = data.keyType;
        this.keyStatus = data.keyStatus;
        this.scopes = data.scopes;
        this.allowedIps = data.allowedIps;
        this.rateLimit = data.rateLimit;
        this.expiresAt = data.expiresAt;
        this.lastUsedAt = data.lastUsedAt;
        this.usageCount = data.usageCount;
        this.rotatedFromKeyId = data.rotatedFromKeyId;
        this.rotatedToKeyId = data.rotatedToKeyId;
        this.rotationExpiresAt = data.rotationExpiresAt;
        this.originalCreatorId = data.originalCreatorId;
        this.description = data.description;
        this.environment = data.environment;
        this.userId = data.userId;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    }
}

