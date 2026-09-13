/**
 * TASK-967 — `CreatePlatformBucket`.
 *
 * A PLATFORM bucket (`hope-models`, `mlflow`, `backups`, the claim check, …)
 * is owned by the SYSTEM tenant, never by a customer tenant: the schema rule
 * is that platform-wide rows carry `SYSTEM_TENANT_ID` because `NULL = global`
 * is banned (`02-database-prisma.md`). SYSTEM already owns
 * `hope-attachments-system`, so this is an existing shape, not a new tier.
 *
 * It is stamped `SYSTEM` rather than `CUSTOM` so the row is self-describing:
 * `CreateNamedBucket` stamps CUSTOM, which is exactly what let an adopted
 * platform bucket sail past `isSystemBucket` on delete.
 */
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { describe, expect, it } from 'vitest';
import { TenantBucketPurpose, TenantBucketType } from '../../../../enums';
import { TenantBucketFactory } from '../TenantBucketFactory';

describe('TenantBucketFactory.CreatePlatformBucket (TASK-967)', () => {
  it('owns the row with the SYSTEM tenant and stamps it SYSTEM', () => {
    const bucket = TenantBucketFactory.CreatePlatformBucket('hope-models');

    expect(bucket.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(bucket.bucketType).toBe(TenantBucketType.SYSTEM);
    expect(bucket.purpose).toBe(TenantBucketPurpose.CUSTOM);
  });

  it('keeps the physical name verbatim — it is the S3 name, not a derived one', () => {
    // `buildBucketName` would turn this into `hope-hope-models-system`, which
    // names no bucket that exists.
    const bucket = TenantBucketFactory.CreatePlatformBucket('hope-models');

    expect(bucket.name).toBe('hope-models');
    expect(bucket.slug).toBe('hope-models');
  });

  it('carries the description and creator through', () => {
    const bucket = TenantBucketFactory.CreatePlatformBucket('mlflow', 'MLflow artifact store', 'user-1');

    expect(bucket.description).toBe('MLflow artifact store');
    expect(bucket.createdBy).toBe('user-1');
  });

  it('defaults description to null rather than undefined', () => {
    expect(TenantBucketFactory.CreatePlatformBucket('backups').description).toBeNull();
  });
});
