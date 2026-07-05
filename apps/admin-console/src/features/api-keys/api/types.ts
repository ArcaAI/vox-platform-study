import type { BaseResource } from '@/shared/api';

export type ApiKeyStatus = 'ACTIVE' | 'INACTIVE' | 'REVOKED' | 'EXPIRED';
export type ApiKeyType = 'SDK' | 'WEBHOOK' | 'INTEGRATION' | 'SERVICE_ACCOUNT';

/** GET /admin/api-keys rows (ApiKeyResponse; date fields serialize to ISO). */
export interface ApiKey extends BaseResource {
    keyName: string;
    keyPrefix: string;
    keyType: ApiKeyType;
    keyStatus: ApiKeyStatus;
    scopes?: string[] | null;
    allowedIps?: string[] | null;
    rateLimit?: number | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
    usageCount: number;
    description?: string | null;
    environment?: string | null;
    userId?: string | null;
    tenantId?: string | null;
}

export interface CreateApiKeyRequest {
    keyName: string;
    keyType?: ApiKeyType;
    /** At least one scope; validate against GET /admin/api-keys/scopes. */
    scopes: string[];
    allowedIps?: string[];
    rateLimit?: number;
    expiresAt?: string;
    description?: string;
    environment?: string;
}

/** POST create and POST :id/rotate — rawKey is shown exactly once. */
export interface CreateApiKeyResult {
    apiKey: ApiKey;
    rawKey: string;
}

export interface UpdateApiKeyRequest {
    keyName?: string;
    keyStatus?: ApiKeyStatus;
    scopes?: string[];
    allowedIps?: string[];
    rateLimit?: number;
    expiresAt?: string;
    description?: string;
    environment?: string;
}

export interface ApiKeyUsage {
    totalCalls: number;
    lastUsedAt: string | null;
    rateLimit: number;
}

/** GET /admin/api-keys/scopes — scopes grouped by category (STT, Admin, ...). */
export type ApiKeyScopeCatalog = Record<string, { scope: string; description: string }[]>;
