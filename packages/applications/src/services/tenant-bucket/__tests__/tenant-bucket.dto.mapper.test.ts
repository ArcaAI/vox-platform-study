/**
 * TenantBucketDtoMapper unit tests.
 *
 * `TenantBucket.quotaBytes` (BigInt) must surface on the response so
 * the tenant-detail Stores surface can render per-bucket quota. Pure function
 * testing — no mocks.
 */

import { describe, it, expect } from 'vitest';
import { TenantBucketDtoMapper } from '../tenant-bucket.dto.mapper';

const baseEntity = {
    id: 'bucket-1',
    tenantId: 'tenant-1',
    name: 'Audio Recordings',
    slug: 'audio-recordings',
    description: 'Consultation audio',
    bucketType: 'MINIO',
    purpose: 'AUDIO',
    pathPattern: '{tenantId}/audio',
    isSystemBucket: true,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-01T12:00:00Z'),
};

describe('TenantBucketDtoMapper (TASK-407)', () => {
    it('maps quotaBytes BigInt to a JSON-safe number', () => {
        const result = TenantBucketDtoMapper.toResponse({ ...baseEntity, quotaBytes: 10_737_418_240n } as never);
        expect(result.quotaBytes).toBe(10_737_418_240);
    });

    it('maps null quotaBytes (unlimited) to null', () => {
        const result = TenantBucketDtoMapper.toResponse({ ...baseEntity, quotaBytes: null } as never);
        expect(result.quotaBytes).toBeNull();
    });

    it('maps undefined quotaBytes to null (pre-TASK-386 rows)', () => {
        const result = TenantBucketDtoMapper.toResponse({ ...baseEntity } as never);
        expect(result.quotaBytes).toBeNull();
    });

    it('keeps the existing field mapping intact', () => {
        const result = TenantBucketDtoMapper.toResponse({ ...baseEntity, quotaBytes: 1024n } as never);
        expect(result.id).toBe('bucket-1');
        expect(result.tenantId).toBe('tenant-1');
        expect(result.slug).toBe('audio-recordings');
        expect(result.bucketType).toBe('MINIO');
        expect(result.purpose).toBe('AUDIO');
        expect(result.isSystemBucket).toBe(true);
        expect(result.createdAt).toBe('2026-07-01T10:00:00.000Z');
    });
});
