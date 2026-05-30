import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { getSecretFields } from '../common';

describe('StorageAccessKey Domain Layer', () => {
    describe('StorageAccessKeyEntity', () => {
        it('should create entity with all required fields', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const entity = new StorageAccessKeyEntity({
                id: 'key-1',
                tenantId: 'tenant-1',
                name: 'Production Read Key',
                description: 'Read-only key for production',
                accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
                secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                permissions: ['read', 'list'],
                bucketIds: ['bucket-1'],
                expiresAt: new Date('2027-01-01'),
                lastUsedAt: null,
                lastUsedIp: null,
                createdAt: new Date('2026-03-08'),
                updatedAt: new Date('2026-03-08'),
            });

            expect(entity.id).toBe('key-1');
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('Production Read Key');
            expect(entity.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
            expect(entity.permissions).toEqual(['read', 'list']);
            expect(entity.bucketIds).toEqual(['bucket-1']);
        });

        it('should mark secretAccessKey as @Secret for audit-log scrubbing', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const secretFields = getSecretFields(StorageAccessKeyEntity.prototype);
            expect(secretFields).toContain('secretAccessKey');
        });

        it('should track changes via setProperty', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const entity = new StorageAccessKeyEntity({
                id: 'key-1',
                tenantId: 'tenant-1',
                name: 'Test Key',
                accessKeyId: 'AKIATEST',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            entity.name = 'Updated Key Name';
            expect(entity.name).toBe('Updated Key Name');
            expect(entity.hasChanges).toBe(true);
        });

        it('should check if key is expired', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const expiredKey = new StorageAccessKeyEntity({
                id: 'key-1',
                tenantId: 'tenant-1',
                name: 'Expired Key',
                accessKeyId: 'AKIAEXPIRED',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: [],
                expiresAt: new Date('2020-01-01'),
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const validKey = new StorageAccessKeyEntity({
                id: 'key-2',
                tenantId: 'tenant-1',
                name: 'Valid Key',
                accessKeyId: 'AKIAVALID',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: [],
                expiresAt: new Date('2030-01-01'),
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const noExpiryKey = new StorageAccessKeyEntity({
                id: 'key-3',
                tenantId: 'tenant-1',
                name: 'No Expiry Key',
                accessKeyId: 'AKIANOEXPIRY',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            expect(expiredKey.isExpired).toBe(true);
            expect(validKey.isExpired).toBe(false);
            expect(noExpiryKey.isExpired).toBe(false);
        });

        it('should check permission', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const entity = new StorageAccessKeyEntity({
                id: 'key-1',
                tenantId: 'tenant-1',
                name: 'Read-Write Key',
                accessKeyId: 'AKIARW',
                secretAccessKey: 'secret',
                permissions: ['read', 'write'],
                bucketIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            expect(entity.hasPermission('read')).toBe(true);
            expect(entity.hasPermission('write')).toBe(true);
            expect(entity.hasPermission('delete')).toBe(false);
        });

        it('should check bucket scope', async () => {
            const { StorageAccessKeyEntity } = await import('../entities/generated/core/StorageAccessKeyEntity');

            const scopedKey = new StorageAccessKeyEntity({
                id: 'key-1',
                tenantId: 'tenant-1',
                name: 'Scoped Key',
                accessKeyId: 'AKIASCOPED',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: ['bucket-1', 'bucket-2'],
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const unscopedKey = new StorageAccessKeyEntity({
                id: 'key-2',
                tenantId: 'tenant-1',
                name: 'Unscoped Key',
                accessKeyId: 'AKIAUNSCOPED',
                secretAccessKey: 'secret',
                permissions: ['read'],
                bucketIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            expect(scopedKey.hasBucketAccess('bucket-1')).toBe(true);
            expect(scopedKey.hasBucketAccess('bucket-3')).toBe(false);
            expect(unscopedKey.hasBucketAccess('any-bucket')).toBe(true);
        });
    });

    describe('StorageAccessKeyFactory', () => {
        it('should generate a raw plaintext secret (43-char base64url) separately from storage', async () => {
            const { StorageAccessKeyFactory } = await import('../factories/generated/core/StorageAccessKeyFactory');

            const raw = StorageAccessKeyFactory.generateRawSecret();

            expect(typeof raw).toBe('string');
            // 32 random bytes encoded as base64url => 43 chars, url-safe alphabet
            expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
            // Two generations must not collide.
            expect(StorageAccessKeyFactory.generateRawSecret()).not.toBe(raw);
        });

        it('should persist the provided secret HASH, never a generated plaintext (F-2)', async () => {
            const { StorageAccessKeyFactory } = await import('../factories/generated/core/StorageAccessKeyFactory');

            const secretHash = 'a'.repeat(64); // shaped like a sha256 hex digest
            const entity = StorageAccessKeyFactory.CreateKey({
                tenantId: 'tenant-1',
                name: 'My Key',
                permissions: ['read', 'write'],
                bucketIds: ['bucket-1'],
                createdBy: 'user-1',
                secretAccessKey: secretHash,
            });

            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('My Key');
            expect(entity.accessKeyId).toBeDefined();
            expect(entity.accessKeyId.length).toBeGreaterThanOrEqual(20);
            // The stored secret is exactly the hash we passed in — the factory
            // must NOT generate its own plaintext secret anymore (F-2).
            expect(entity.secretAccessKey).toBe(secretHash);
            // ...and it must not look like the 43-char base64url raw secret.
            expect(entity.secretAccessKey).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(entity.permissions).toEqual(['read', 'write']);
            expect(entity.bucketIds).toEqual(['bucket-1']);
        });

        it('should create key with default read-only permissions when none specified', async () => {
            const { StorageAccessKeyFactory } = await import('../factories/generated/core/StorageAccessKeyFactory');

            const entity = StorageAccessKeyFactory.CreateKey({
                tenantId: 'tenant-1',
                name: 'Default Key',
                secretAccessKey: 'b'.repeat(64),
            });

            expect(entity.permissions).toEqual(['read']);
            expect(entity.bucketIds).toEqual([]);
        });
    });
});
