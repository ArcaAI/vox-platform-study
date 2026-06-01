import { describe, expect, it } from 'vitest';

describe('TenantBucket Domain Layer', () => {
    describe('TenantBucketEntity', () => {
        it('should create entity with all required fields', async () => {
            const { TenantBucketEntity } = await import('../entities/generated/core/TenantBucketEntity');
            const { TenantBucketType } = await import('../enums');

            const entity = new TenantBucketEntity({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'hope-audio-arcaai',
                slug: 'audio',
                description: 'Tenant audio storage',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}',
                createdAt: new Date('2026-03-08'),
                updatedAt: new Date('2026-03-08'),
            });

            expect(entity.id).toBe('bucket-1');
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('hope-audio-arcaai');
            expect(entity.slug).toBe('audio');
            expect(entity.description).toBe('Tenant audio storage');
            expect(entity.bucketType).toBe(TenantBucketType.SYSTEM);
            expect(entity.pathPattern).toBe('{yyyy}/{MM}');
        });

        it('should track changes via setProperty', async () => {
            const { TenantBucketEntity } = await import('../entities/generated/core/TenantBucketEntity');
            const { TenantBucketType } = await import('../enums');

            const entity = new TenantBucketEntity({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'hope-audio-arcaai',
                slug: 'audio',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            entity.description = 'Updated description';
            expect(entity.description).toBe('Updated description');
            expect(entity.hasChanges).toBe(true);
        });

        it('should identify system buckets', async () => {
            const { TenantBucketEntity } = await import('../entities/generated/core/TenantBucketEntity');
            const { TenantBucketType } = await import('../enums');

            const systemBucket = new TenantBucketEntity({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'hope-audio-arcaai',
                slug: 'audio',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const customBucket = new TenantBucketEntity({
                id: 'bucket-2',
                tenantId: 'tenant-1',
                name: 'arcaai-reports',
                slug: 'reports',
                bucketType: TenantBucketType.CUSTOM,
                pathPattern: '{yyyy}/{MM}/{dd}',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            expect(systemBucket.isSystemBucket).toBe(true);
            expect(customBucket.isSystemBucket).toBe(false);
        });
    });

    describe('TenantBucketFactory', () => {
        it('should create a system bucket with generated id', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');
            const { TenantBucketType } = await import('../enums');

            const entity = TenantBucketFactory.CreateSystemBucket(
                'tenant-1',
                'arcaai',
                'audio',
                'Tenant audio storage',
            );

            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('hope-audio-arcaai');
            expect(entity.slug).toBe('audio');
            expect(entity.bucketType).toBe(TenantBucketType.SYSTEM);
            expect(entity.pathPattern).toBe('{yyyy}/{MM}');
        });

        it('should create a custom bucket with generated id', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');
            const { TenantBucketType } = await import('../enums');

            const entity = TenantBucketFactory.CreateCustomBucket(
                'tenant-1',
                'arcaai',
                'reports',
                'Business reports storage',
                'user-1',
            );

            expect(entity.id).toBeDefined();
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('hope-reports-arcaai');
            expect(entity.slug).toBe('reports');
            expect(entity.bucketType).toBe(TenantBucketType.CUSTOM);
        });

        it('should create default system buckets for a tenant', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');
            const { TenantBucketType } = await import('../enums');

            const buckets = TenantBucketFactory.CreateDefaultSystemBuckets('tenant-1', 'arcaai');

            expect(buckets).toHaveLength(3);

            const audioBucket = buckets[0];
            expect(audioBucket.slug).toBe('audio');
            expect(audioBucket.name).toBe('hope-audio-arcaai');
            expect(audioBucket.bucketType).toBe(TenantBucketType.SYSTEM);

            const attachmentsBucket = buckets[1];
            expect(attachmentsBucket.slug).toBe('attachments');
            expect(attachmentsBucket.name).toBe('hope-attachments-arcaai');
            expect(attachmentsBucket.bucketType).toBe(TenantBucketType.SYSTEM);

            const miscBucket = buckets[2];
            expect(miscBucket.slug).toBe('misc');
            expect(miscBucket.name).toBe('hope-misc-arcaai');
            expect(miscBucket.bucketType).toBe(TenantBucketType.SYSTEM);
        });

        it('should sanitize tenant key in bucket name', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');

            const entity = TenantBucketFactory.CreateCustomBucket(
                'tenant-1',
                'My Hospital Name',
                'documents',
            );

            expect(entity.name).toBe('hope-documents-my-hospital-name');
        });
    });

    describe('TenantBucketModel', () => {
        it('should construct with all fields', async () => {
            const { TenantBucket } = await import('../models/generated/core/TenantBucketModel');
            const { TenantBucketType, ResourceStatusType } = await import('../enums');

            const model = new TenantBucket({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'hope-audio-arcaai',
                slug: 'audio',
                description: 'Audio recordings',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
                resourceStatus: ResourceStatusType.ENABLED,
                resourceStatusUpdatedAt: null,
                resourceStatusUpdatedBy: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                createdBy: null,
                updatedBy: null,
                metaData: null,
                version: 1,
                tags: [],
            } as any);

            expect(model.name).toBe('hope-audio-arcaai');
            expect(model.slug).toBe('audio');
            expect(model.bucketType).toBe(TenantBucketType.SYSTEM);
        });
    });
});
