import { generateId } from '../../../utils';
import { TenantBucketEntity, ITenantBucketEntity } from '../../../entities/generated/core/TenantBucketEntity';
import { TenantBucketType } from '../../../enums';

export const SYSTEM_BUCKET_SLUGS = {
    AUDIO_RECORDINGS: 'audio_recordings',
    UPLOADED_RECORDINGS: 'uploaded_recordings',
} as const;

const SYSTEM_BUCKET_DESCRIPTIONS: Record<string, string> = {
    [SYSTEM_BUCKET_SLUGS.AUDIO_RECORDINGS]: 'Live streaming audio recordings',
    [SYSTEM_BUCKET_SLUGS.UPLOADED_RECORDINGS]: 'Uploaded files for batch transcription',
};

function sanitizeBucketName(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function buildBucketName(tenantKey: string, slug: string): string {
    const sanitizedKey = sanitizeBucketName(tenantKey);
    const sanitizedSlug = sanitizeBucketName(slug.replace(/_/g, '-'));
    return `${sanitizedKey}-${sanitizedSlug}`;
}

export class TenantBucketFactory {
    static CreateSystemBucket(
        tenantId: string,
        tenantKey: string,
        slug: string,
        description?: string,
        createdBy?: string,
    ): TenantBucketEntity {
        return new TenantBucketEntity({
            id: generateId(),
            tenantId,
            name: buildBucketName(tenantKey, slug),
            slug,
            description: description ?? SYSTEM_BUCKET_DESCRIPTIONS[slug] ?? null,
            bucketType: TenantBucketType.SYSTEM,
            pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
            createdAt: new Date(),
            updatedAt: new Date(),
            createdBy: createdBy ?? null,
            updatedBy: null,
        });
    }

    static CreateCustomBucket(
        tenantId: string,
        tenantKey: string,
        slug: string,
        description?: string,
        createdBy?: string,
        pathPattern?: string,
    ): TenantBucketEntity {
        return new TenantBucketEntity({
            id: generateId(),
            tenantId,
            name: buildBucketName(tenantKey, slug),
            slug,
            description: description ?? null,
            bucketType: TenantBucketType.CUSTOM,
            pathPattern: pathPattern ?? '{yyyy}/{MM}/{dd}/{user_name}',
            createdAt: new Date(),
            updatedAt: new Date(),
            createdBy: createdBy ?? null,
            updatedBy: null,
        });
    }

    static CreateDefaultSystemBuckets(
        tenantId: string,
        tenantKey: string,
        createdBy?: string,
    ): TenantBucketEntity[] {
        return [
            this.CreateSystemBucket(tenantId, tenantKey, SYSTEM_BUCKET_SLUGS.AUDIO_RECORDINGS, undefined, createdBy),
            this.CreateSystemBucket(tenantId, tenantKey, SYSTEM_BUCKET_SLUGS.UPLOADED_RECORDINGS, undefined, createdBy),
        ];
    }
}
