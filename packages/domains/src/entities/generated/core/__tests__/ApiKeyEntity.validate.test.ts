/**
 * ApiKeyEntity.validate() Unit Tests
 *
 * Tests the domain entity business validation rules:
 * - Required fields: keyName, keyHash, keyPrefix, keyType, keyStatus
 * - Length constraints: keyName <= 255, description <= 1000
 * - Range constraints: rateLimit >= 0
 * - Logical constraints: expiresAt > createdAt
 */

import { describe, it, expect } from 'vitest';
import { ApiKeyEntity, IApiKeyEntity } from '../ApiKeyEntity';
import {
    ApiKeyType,
    ApiKeyStatus,
    ResourceStatusType,
} from '../../../../enums';

// Factory for creating valid init data with optional overrides
function createValidInit(overrides: Partial<IApiKeyEntity> = {}): IApiKeyEntity {
    return {
        id: 'test-id',
        keyName: 'Test Key',
        keyHash: 'a'.repeat(64),
        keyPrefix: 'hope_sk_test',
        keyChecksum: 'abc123',
        keyType: ApiKeyType.SDK,
        keyStatus: ApiKeyStatus.ACTIVE,
        scopes: null,
        allowedIps: null,
        rateLimit: 0,
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 0,
        rotatedFromKeyId: null,
        rotatedToKeyId: null,
        rotationExpiresAt: null,
        originalCreatorId: null,
        description: null,
        environment: null,
        userId: null,
        tenantId: 'tenant-1',
        Tenant: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        createdBy: 'user-1',
        updatedBy: null,
        resourceStatus: ResourceStatusType.ENABLED,
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        metaData: null,
        version: 1,
        ...overrides,
    } as IApiKeyEntity;
}

describe('ApiKeyEntity.validate()', () => {
    // ─── Valid Entity ────────────────────────────────────────────────

    it('should not throw for a valid entity', () => {
        const entity = new ApiKeyEntity(createValidInit());

        expect(() => entity.validate()).not.toThrow();
    });

    // ─── keyName Validation ─────────────────────────────────────────

    describe('keyName', () => {
        it('should throw when keyName is empty', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyName: '' }));

            expect(() => entity.validate()).toThrow('API key name is required');
        });

        it('should throw when keyName is whitespace only', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyName: '   ' }));

            expect(() => entity.validate()).toThrow('API key name is required');
        });

        it('should throw when keyName exceeds 255 characters', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyName: 'x'.repeat(256) }));

            expect(() => entity.validate()).toThrow('must not exceed 255 characters');
        });

        it('should accept keyName exactly 255 characters', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyName: 'x'.repeat(255) }));

            expect(() => entity.validate()).not.toThrow();
        });
    });

    // ─── keyHash Validation ─────────────────────────────────────────

    describe('keyHash', () => {
        it('should throw when keyHash is empty', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyHash: '' }));

            expect(() => entity.validate()).toThrow('API key hash is required');
        });

        it('should throw when keyHash is whitespace only', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyHash: '   ' }));

            expect(() => entity.validate()).toThrow('API key hash is required');
        });
    });

    // ─── keyPrefix Validation ───────────────────────────────────────

    describe('keyPrefix', () => {
        it('should throw when keyPrefix is empty', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyPrefix: '' }));

            expect(() => entity.validate()).toThrow('API key prefix is required');
        });

        it('should throw when keyPrefix is whitespace only', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyPrefix: '   ' }));

            expect(() => entity.validate()).toThrow('API key prefix is required');
        });
    });

    // ─── keyType Validation ─────────────────────────────────────────

    describe('keyType', () => {
        it('should throw when keyType is not set', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyType: undefined as any }));

            expect(() => entity.validate()).toThrow('API key type is required');
        });
    });

    // ─── keyStatus Validation ───────────────────────────────────────

    describe('keyStatus', () => {
        it('should throw when keyStatus is not set', () => {
            const entity = new ApiKeyEntity(createValidInit({ keyStatus: undefined as any }));

            expect(() => entity.validate()).toThrow('API key status is required');
        });

        it('should accept all valid status values', () => {
            for (const status of Object.values(ApiKeyStatus)) {
                const entity = new ApiKeyEntity(createValidInit({ keyStatus: status }));
                expect(() => entity.validate()).not.toThrow();
            }
        });
    });

    // ─── rateLimit Validation ───────────────────────────────────────

    describe('rateLimit', () => {
        it('should throw when rateLimit is negative', () => {
            const entity = new ApiKeyEntity(createValidInit({ rateLimit: -1 }));

            expect(() => entity.validate()).toThrow('non-negative');
        });

        it('should accept rateLimit of 0', () => {
            const entity = new ApiKeyEntity(createValidInit({ rateLimit: 0 }));

            expect(() => entity.validate()).not.toThrow();
        });

        it('should accept null rateLimit', () => {
            const entity = new ApiKeyEntity(createValidInit({ rateLimit: null }));

            expect(() => entity.validate()).not.toThrow();
        });

        it('should accept undefined rateLimit', () => {
            const entity = new ApiKeyEntity(createValidInit({ rateLimit: undefined }));

            expect(() => entity.validate()).not.toThrow();
        });

        it('should accept positive rateLimit', () => {
            const entity = new ApiKeyEntity(createValidInit({ rateLimit: 1000 }));

            expect(() => entity.validate()).not.toThrow();
        });
    });

    // ─── expiresAt Validation ───────────────────────────────────────

    describe('expiresAt', () => {
        it('should throw when expiresAt is before createdAt', () => {
            const entity = new ApiKeyEntity(createValidInit({
                createdAt: new Date('2026-06-01'),
                expiresAt: new Date('2026-01-01'),
            }));

            expect(() => entity.validate()).toThrow('after the creation date');
        });

        it('should accept expiresAt after createdAt', () => {
            const entity = new ApiKeyEntity(createValidInit({
                createdAt: new Date('2026-01-01'),
                expiresAt: new Date('2027-01-01'),
            }));

            expect(() => entity.validate()).not.toThrow();
        });

        it('should accept null expiresAt (no expiration)', () => {
            const entity = new ApiKeyEntity(createValidInit({ expiresAt: null }));

            expect(() => entity.validate()).not.toThrow();
        });
    });

    // ─── description Validation ─────────────────────────────────────

    describe('description', () => {
        it('should throw when description exceeds 1000 characters', () => {
            const entity = new ApiKeyEntity(createValidInit({ description: 'x'.repeat(1001) }));

            expect(() => entity.validate()).toThrow('must not exceed 1000 characters');
        });

        it('should accept description exactly 1000 characters', () => {
            const entity = new ApiKeyEntity(createValidInit({ description: 'x'.repeat(1000) }));

            expect(() => entity.validate()).not.toThrow();
        });

        it('should accept null description', () => {
            const entity = new ApiKeyEntity(createValidInit({ description: null }));

            expect(() => entity.validate()).not.toThrow();
        });
    });

    // ─── All key types should validate ──────────────────────────────

    describe('keyType variants', () => {
        it.each(Object.values(ApiKeyType))('should accept keyType %s', (keyType) => {
            const entity = new ApiKeyEntity(createValidInit({ keyType }));
            expect(() => entity.validate()).not.toThrow();
        });
    });
});
