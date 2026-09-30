/**
 * TASK-1025 G1 (owner decision OD-1, 2026-09-30) — provisioning a tenant's two
 * system buckets FAILS AND ROLLS BACK.
 *
 * Before this ticket a failed physical create was logged as "may already exist,
 * continuing" and the `TenantBucket` row was written anyway, so the registry
 * could name a bucket that did not exist and every later read failed with
 * `NoSuchBucket`. Now: every physical bucket is created BEFORE any row is
 * written, a storage failure raises, and nothing the attempt made is kept — no
 * row, and no bucket this attempt created (best effort; a bucket that already
 * existed is adopted, never removed).
 *
 * The tenant-isolation bucket POLICY stays best-effort by design (see the
 * ticket README): the `hope-platform` MinIO identity holds no
 * `s3:PutBucketPolicy`, and the `aws:PrincipalTag` condition is inert in MinIO.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantBucketService } from '../tenant-bucket.service';

vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TenantBucketFactory: {
      CreateDefaultSystemBuckets: vi.fn((tenantId: string, tenantKey: string) => [
        {
          id: 'row-attachments',
          tenantId,
          name: `hope-attachments-${tenantKey}`,
          slug: 'attachments',
          bucketType: 'SYSTEM',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'row-recordings',
          tenantId,
          name: `hope-recordings-${tenantKey}`,
          slug: 'recordings',
          bucketType: 'SYSTEM',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    },
  };
});

const repo = {
  findSystemBuckets: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};
const tenantRepo = { findById: vi.fn() };
const blob = {
  bucketExists: vi.fn(),
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
};
const s3 = { setBucketPolicy: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

function build(): TenantBucketService {
  return new TenantBucketService(repo as never, tenantRepo as never, blob as never, s3 as never, events as never, cls as never);
}

describe('TenantBucketService.provisionSystemBuckets — TASK-1025 G1 fail-and-roll-back', () => {
  let service: TenantBucketService;

  beforeEach(() => {
    vi.clearAllMocks();
    tenantRepo.findById.mockResolvedValue({ id: 'tenant-1', key: 'acme' });
    repo.findSystemBuckets.mockResolvedValue([]);
    repo.create.mockImplementation(async (entity: unknown) => entity);
    repo.delete.mockResolvedValue(undefined);
    blob.bucketExists.mockResolvedValue(false);
    blob.createBucket.mockResolvedValue(undefined);
    blob.deleteBucket.mockResolvedValue(undefined);
    s3.setBucketPolicy.mockResolvedValue(undefined);
    service = build();
  });

  it('creates both physical buckets BEFORE writing any row, then writes both rows', async () => {
    const order: string[] = [];
    blob.createBucket.mockImplementation(async (name: string) => void order.push(`bucket:${name}`));
    repo.create.mockImplementation(async (entity: { name: string }) => {
      order.push(`row:${entity.name}`);
      return entity;
    });

    const result = await service.provisionSystemBuckets('tenant-1');

    expect(result.map((b) => b.slug).sort()).toEqual(['attachments', 'recordings']);
    expect(order).toEqual(['bucket:hope-attachments-acme', 'bucket:hope-recordings-acme', 'row:hope-attachments-acme', 'row:hope-recordings-acme']);
  });

  it('fails with a clear 503 and writes NO row when a physical create fails', async () => {
    blob.createBucket.mockImplementation(async (name: string) => {
      if (name === 'hope-recordings-acme') throw new Error('AccessDenied');
    });

    const attempt = service.provisionSystemBuckets('tenant-1');

    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(attempt).rejects.toThrow(/hope-recordings-acme/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('removes the bucket THIS attempt created when a later bucket fails', async () => {
    blob.createBucket.mockImplementation(async (name: string) => {
      if (name === 'hope-recordings-acme') throw new Error('AccessDenied');
    });

    await expect(service.provisionSystemBuckets('tenant-1')).rejects.toThrow(ServiceUnavailableException);

    expect(blob.deleteBucket).toHaveBeenCalledTimes(1);
    expect(blob.deleteBucket).toHaveBeenCalledWith('hope-attachments-acme');
  });

  it('never removes a bucket that already existed before the attempt (adopted, not created)', async () => {
    blob.bucketExists.mockImplementation(async (name: string) => name === 'hope-attachments-acme');
    blob.createBucket.mockRejectedValue(new Error('AccessDenied'));

    await expect(service.provisionSystemBuckets('tenant-1')).rejects.toThrow(ServiceUnavailableException);

    expect(blob.createBucket).toHaveBeenCalledTimes(1);
    expect(blob.createBucket).toHaveBeenCalledWith('hope-recordings-acme');
    expect(blob.deleteBucket).not.toHaveBeenCalled();
  });

  it('treats an existence-check failure (storage unreachable) as a provisioning failure', async () => {
    blob.bucketExists.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(service.provisionSystemBuckets('tenant-1')).rejects.toThrow(ServiceUnavailableException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('tolerates losing a create race to ourselves (BucketAlreadyOwnedByYou) — the bucket is adopted', async () => {
    blob.createBucket.mockImplementation(async (name: string) => {
      if (name === 'hope-attachments-acme') throw Object.assign(new Error('already owned'), { name: 'BucketAlreadyOwnedByYou' });
    });

    const result = await service.provisionSystemBuckets('tenant-1');

    expect(result).toHaveLength(2);
    expect(blob.deleteBucket).not.toHaveBeenCalled();
  });

  it('hard-deletes the rows already written and removes created buckets when a row write fails', async () => {
    repo.create.mockImplementation(async (entity: { name: string }) => {
      if (entity.name === 'hope-recordings-acme') throw new Error('unique constraint');
      return entity;
    });

    await expect(service.provisionSystemBuckets('tenant-1')).rejects.toThrow(ServiceUnavailableException);

    expect(repo.delete).toHaveBeenCalledWith('row-attachments');
    expect(blob.deleteBucket).toHaveBeenCalledWith('hope-attachments-acme');
    expect(blob.deleteBucket).toHaveBeenCalledWith('hope-recordings-acme');
  });

  it('still raises the provisioning error when the best-effort bucket removal itself fails', async () => {
    blob.createBucket.mockImplementation(async (name: string) => {
      if (name === 'hope-recordings-acme') throw new Error('AccessDenied');
    });
    blob.deleteBucket.mockRejectedValue(new Error('AccessDenied on DeleteBucket'));

    await expect(service.provisionSystemBuckets('tenant-1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('keeps the tenant-isolation bucket POLICY best-effort: a refused policy does not fail provisioning', async () => {
    s3.setBucketPolicy.mockRejectedValue(new Error('AccessDenied: s3:PutBucketPolicy'));

    const result = await service.provisionSystemBuckets('tenant-1');

    expect(result).toHaveLength(2);
    expect(blob.deleteBucket).not.toHaveBeenCalled();
  });
});
