import { describe, it, expect } from 'vitest';

describe('TenantBucket Domain Layer', () => {
    describe('TenantBucketEntity', () => {
        it('should create entity with all required fields', async () => {
            const { TenantBucketEntity } = await import('../entities/generated/core/TenantBucketEntity');
            const { TenantBucketType } = await import('../enums');

            const entity = new TenantBucketEntity({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'arcaai-audio-recordings',
                slug: 'audio_recordings',
                description: 'Live streaming recordings',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
                createdAt: new Date('2026-03-08'),
                updatedAt: new Date('2026-03-08'),
            });

            expect(entity.id).toBe('bucket-1');
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('arcaai-audio-recordings');
            expect(entity.slug).toBe('audio_recordings');
            expect(entity.description).toBe('Live streaming recordings');
            expect(entity.bucketType).toBe(TenantBucketType.SYSTEM);
            expect(entity.pathPattern).toBe('{yyyy}/{MM}/{dd}/{user_name}');
        });

        it('should track changes via setProperty', async () => {
            const { TenantBucketEntity } = await import('../entities/generated/core/TenantBucketEntity');
            const { TenantBucketType } = await import('../enums');

            const entity = new TenantBucketEntity({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'arcaai-audio-recordings',
                slug: 'audio_recordings',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
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
                name: 'arcaai-audio-recordings',
                slug: 'audio_recordings',
                bucketType: TenantBucketType.SYSTEM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
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
                'audio_recordings',
                'Live streaming audio recordings',
            );

            expect(entity.id).toBeDefined();
            expect(entity.id.length).toBeGreaterThan(0);
            expect(entity.tenantId).toBe('tenant-1');
            expect(entity.name).toBe('arcaai-audio-recordings');
            expect(entity.slug).toBe('audio_recordings');
            expect(entity.bucketType).toBe(TenantBucketType.SYSTEM);
            expect(entity.pathPattern).toBe('{yyyy}/{MM}/{dd}/{user_name}');
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
            expect(entity.name).toBe('arcaai-reports');
            expect(entity.slug).toBe('reports');
            expect(entity.bucketType).toBe(TenantBucketType.CUSTOM);
        });

        it('should create both default system buckets for a tenant', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');
            const { TenantBucketType } = await import('../enums');

            const buckets = TenantBucketFactory.CreateDefaultSystemBuckets('tenant-1', 'arcaai');

            expect(buckets).toHaveLength(2);

            const audioRecordings = buckets.find(b => b.slug === 'audio_recordings');
            expect(audioRecordings).toBeDefined();
            expect(audioRecordings!.name).toBe('arcaai-audio-recordings');
            expect(audioRecordings!.bucketType).toBe(TenantBucketType.SYSTEM);

            const uploadedRecordings = buckets.find(b => b.slug === 'uploaded_recordings');
            expect(uploadedRecordings).toBeDefined();
            expect(uploadedRecordings!.name).toBe('arcaai-uploaded-recordings');
            expect(uploadedRecordings!.bucketType).toBe(TenantBucketType.SYSTEM);
        });

        it('should sanitize tenant key in bucket name', async () => {
            const { TenantBucketFactory } = await import('../factories/generated/core/TenantBucketFactory');

            const entity = TenantBucketFactory.CreateCustomBucket(
                'tenant-1',
                'My Hospital Name',
                'documents',
            );

            expect(entity.name).toBe('my-hospital-name-documents');
        });
    });

    describe('TenantBucketModel', () => {
        it('should construct with all fields', async () => {
            const { TenantBucket } = await import('../models/generated/core/TenantBucketModel');
            const { TenantBucketType, ResourceStatusType } = await import('../enums');

            const model = new TenantBucket({
                id: 'bucket-1',
                tenantId: 'tenant-1',
                name: 'arcaai-audio-recordings',
                slug: 'audio_recordings',
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

            expect(model.name).toBe('arcaai-audio-recordings');
            expect(model.slug).toBe('audio_recordings');
            expect(model.bucketType).toBe(TenantBucketType.SYSTEM);
        });
    });
});
