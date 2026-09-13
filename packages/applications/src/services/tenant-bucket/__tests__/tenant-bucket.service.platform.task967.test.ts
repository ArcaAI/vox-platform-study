/**
 * TASK-967 — a platform admin manages platform buckets.
 *
 * Owner directive, 2026-09-13: "platform admin MUST be able to manage any
 * buckets including registering or creating new bucket". Two decisions give
 * it shape:
 *
 * - OD-1 a registered platform bucket is owned by the SYSTEM tenant, never by
 *   a customer tenant.
 * - OD-2 a platform admin MAY delete one. The provider still wins — object
 *   lock on `hope-models` makes MinIO refuse and `deleteBucket` re-raises that
 *   verbatim rather than soft-deleting the row.
 *
 * The boundary the widened `scope: 'super-admin'` decorators lean on is
 * asserted here, in the service: an UNSCOPED platform admin may WRITE only to
 * SYSTEM rows. A customer tenant's bucket still requires selecting that
 * tenant, which is what keeps the "Acting on: «Tenant»" banner on the act.
 */
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantBucketService } from '../tenant-bucket.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockTenantBucketRepository = {
  findAllByTenant: vi.fn(),
  findAllCrossTenant: vi.fn(),
  findBySlug: vi.fn(),
  findByName: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};
const mockTenantRepository = { findById: vi.fn(), findAll: vi.fn() };
const mockBlobStorage = {
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn(),
  presignGet: vi.fn(),
  bucketExists: vi.fn(),
};
const mockS3Service = { setBucketPolicy: vi.fn(), listAllBuckets: vi.fn() };

/** A stored row as the repository hands it back. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bucket-1',
    tenantId: 'tenant-1',
    name: 'hope-reports-arcaai',
    slug: 'reports',
    description: null,
    bucketType: 'CUSTOM',
    pathPattern: '{yyyy}/{MM}/{dd}',
    resourceStatus: 'ENABLED',
    isSystemBucket: false,
    createdAt: new Date('2026-03-08'),
    updatedAt: new Date('2026-03-08'),
    ...overrides,
  };
}

/** A SYSTEM-tenant row for one of the nine platform bucket names. */
function platformRow(name = 'hope-models', overrides: Partial<Record<string, unknown>> = {}) {
  return row({ id: 'platform-1', tenantId: SYSTEM_TENANT_ID, name, slug: name, bucketType: 'SYSTEM', isSystemBucket: true, ...overrides });
}

function asUser(user: unknown, tenantId: string | null) {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'user') return user;
    if (key === 'tenantId') return tenantId;
    return null;
  });
}

const SUPER_ADMIN = { id: 'user-super', roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = { id: 'user-admin', roles: ['ADMIN'] };

describe('TenantBucketService — platform bucket management (TASK-967)', () => {
  let service: TenantBucketService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBlobStorage.bucketExists.mockResolvedValue(true);
    mockTenantBucketRepository.create.mockImplementation((bucket: unknown) => Promise.resolve(bucket));
    mockTenantBucketRepository.findByName.mockResolvedValue(null);
    mockTenantRepository.findById.mockResolvedValue({ id: SYSTEM_TENANT_ID, key: 'system', name: 'System' });
    mockS3Service.listAllBuckets.mockResolvedValue([{ name: 'hope-models', creationDate: '2026-01-01T00:00:00.000Z' }]);
    asUser(SUPER_ADMIN, null);

    service = new TenantBucketService(
      mockTenantBucketRepository as never,
      mockTenantRepository as never,
      mockBlobStorage as never,
      mockS3Service as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  describe('adoptPhysicalBucket — OD-1, SYSTEM owns a platform bucket', () => {
    it('registers a platform bucket to the SYSTEM tenant, stamped SYSTEM', async () => {
      const result = await service.adoptPhysicalBucket('hope-models', SYSTEM_TENANT_ID);

      expect(result).toMatchObject({ name: 'hope-models', tenantId: SYSTEM_TENANT_ID });
      expect(mockTenantBucketRepository.create).toHaveBeenCalledWith(expect.objectContaining({ bucketType: 'SYSTEM' }));
      // Registry-only: adoption never touches storage.
      expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
      expect(mockBlobStorage.deleteBucket).not.toHaveBeenCalled();
    });

    it('refuses to register a platform bucket to a CUSTOMER tenant, and names SYSTEM as the remedy', async () => {
      mockTenantRepository.findById.mockResolvedValue({ id: 'tenant-2', key: 'arcaai', name: 'ArcaAI' });

      await expect(service.adoptPhysicalBucket('hope-models', 'tenant-2')).rejects.toThrow(BadRequestException);
      await expect(service.adoptPhysicalBucket('hope-models', 'tenant-2')).rejects.toThrow(/System tenant/i);
      expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
    });

    // There is no super-admin CASL subject, so `@CanCreate('Storage')` cannot
    // express this — it is imperative, and it is a 403 privilege boundary.
    it('refuses a non-super-admin outright (403), even one holding manage:Storage', async () => {
      asUser(TENANT_ADMIN, 'tenant-1');

      await expect(service.adoptPhysicalBucket('hope-models', SYSTEM_TENANT_ID)).rejects.toThrow(ForbiddenException);
      expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
    });

    it('leaves an ordinary bucket adoption exactly as it was', async () => {
      mockTenantRepository.findById.mockResolvedValue({ id: 'tenant-2', key: 'arcaai', name: 'ArcaAI' });
      mockS3Service.listAllBuckets.mockResolvedValue([{ name: 'legacy-exports', creationDate: '2026-01-02T00:00:00.000Z' }]);

      const result = await service.adoptPhysicalBucket('legacy-exports', 'tenant-2');

      expect(result).toMatchObject({ name: 'legacy-exports', tenantId: 'tenant-2' });
      expect(mockTenantBucketRepository.create).toHaveBeenCalledWith(expect.objectContaining({ bucketType: 'CUSTOM' }));
    });
  });

  describe('registerBucket — G-3, a platform admin creating a bucket gets a row, not an orphan', () => {
    it('registers to SYSTEM when there is no tenant context and the caller is a platform admin', async () => {
      const result = await service.registerBucket('platform-scratch');

      expect(result).toMatchObject({ name: 'platform-scratch', tenantId: SYSTEM_TENANT_ID });
      // CUSTOM, not SYSTEM: this is an ordinary bucket that happens to be
      // platform-owned. Stamping SYSTEM would make it undeletable.
      expect(mockTenantBucketRepository.create).toHaveBeenCalledWith(expect.objectContaining({ bucketType: 'CUSTOM' }));
    });

    it('registers a platform NAME to SYSTEM stamped SYSTEM', async () => {
      const result = await service.registerBucket('hope-models');

      expect(result).toMatchObject({ name: 'hope-models', tenantId: SYSTEM_TENANT_ID });
      expect(mockTenantBucketRepository.create).toHaveBeenCalledWith(expect.objectContaining({ bucketType: 'SYSTEM' }));
    });

    it('still skips silently for a non-super-admin with no tenant context', async () => {
      asUser(TENANT_ADMIN, null);

      expect(await service.registerBucket('platform-scratch')).toBeNull();
      expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a platform name for a TENANT-bound caller — SYSTEM owns it, not them', async () => {
      asUser(TENANT_ADMIN, 'tenant-1');

      await expect(service.registerBucket('hope-models')).rejects.toThrow(ForbiddenException);
      expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
    });

    it('still registers an ordinary bucket to the caller tenant', async () => {
      asUser(TENANT_ADMIN, 'tenant-1');

      const result = await service.registerBucket('legacy-exports');

      expect(result).toMatchObject({ name: 'legacy-exports', tenantId: 'tenant-1' });
    });
  });

  describe('deleteBucket — OD-2, a platform admin may destroy a platform bucket', () => {
    it('deletes a platform bucket for a platform admin', async () => {
      const bucket = platformRow('backups');
      mockTenantBucketRepository.findById.mockResolvedValue(bucket);
      mockTenantBucketRepository.softDelete.mockResolvedValue(bucket);
      mockBlobStorage.deleteBucket.mockResolvedValue(undefined);

      const result = await service.deleteBucket('platform-1');

      expect(mockBlobStorage.deleteBucket).toHaveBeenCalledWith('backups');
      expect(result.name).toBe('backups');
    });

    it('refuses a non-super-admin (403) even though the row would otherwise be reachable', async () => {
      asUser(TENANT_ADMIN, SYSTEM_TENANT_ID);
      mockTenantBucketRepository.findById.mockResolvedValue(platformRow('backups'));

      await expect(service.deleteBucket('platform-1')).rejects.toThrow(ForbiddenException);
      expect(mockBlobStorage.deleteBucket).not.toHaveBeenCalled();
    });

    // The object-lock case. The row must survive so the registry keeps
    // matching what is actually in storage.
    it("surfaces the provider's refusal verbatim and leaves the row intact", async () => {
      mockTenantBucketRepository.findById.mockResolvedValue(platformRow('hope-models'));
      mockBlobStorage.deleteBucket.mockRejectedValue(new Error('Object Lock configuration is present'));

      await expect(service.deleteBucket('platform-1')).rejects.toThrow(/Object Lock configuration is present/);
      expect(mockTenantBucketRepository.softDelete).not.toHaveBeenCalled();
    });

    // Unchanged: a TENANT's own system buckets stay undeletable. Only a
    // platform NAME opens the door, and only for a platform admin.
    it("still refuses a tenant's own SYSTEM bucket", async () => {
      asUser(SUPER_ADMIN, 'tenant-1');
      mockTenantBucketRepository.findById.mockResolvedValue(row({ bucketType: 'SYSTEM', isSystemBucket: true, name: 'hope-attachments-arcaai' }));

      await expect(service.deleteBucket('bucket-1')).rejects.toThrow(ForbiddenException);
      expect(mockBlobStorage.deleteBucket).not.toHaveBeenCalled();
    });
  });

  describe('the boundary behind the widened super-admin scope', () => {
    // `79bdd4a6d` declined to widen delete because an unscoped delete destroys
    // a physical bucket with no "Acting on: «Tenant»" banner. That reasoning
    // holds for a CUSTOMER row and is preserved here; it does not hold for a
    // SYSTEM row, which has no customer to name.
    it.each([
      ['deleteBucket', (s: TenantBucketService) => s.deleteBucket('bucket-1')],
      ['uploadObject', (s: TenantBucketService) => s.uploadObject('bucket-1', 'k.txt', Buffer.from('x'))],
      ['deleteObject', (s: TenantBucketService) => s.deleteObject('bucket-1', 'k.txt')],
      ['getPresignedUrl', (s: TenantBucketService) => s.getPresignedUrl('bucket-1', 'k.txt')],
    ])('404s an UNSCOPED platform admin writing to a CUSTOMER row (%s)', async (_label, act) => {
      mockTenantBucketRepository.findById.mockResolvedValue(row({ tenantId: 'tenant-1' }));

      await expect(act(service)).rejects.toThrow(NotFoundException);
      expect(mockBlobStorage.deleteBucket).not.toHaveBeenCalled();
      expect(mockBlobStorage.putObject).not.toHaveBeenCalled();
      expect(mockBlobStorage.deleteObject).not.toHaveBeenCalled();
    });

    // Reads stay as TASK-932 left them: the "All tenants" view browses every
    // tenant's objects. Only writes and downloads narrow to SYSTEM.
    it('still lets an unscoped platform admin BROWSE a customer row', async () => {
      mockTenantBucketRepository.findById.mockResolvedValue(row({ tenantId: 'tenant-1' }));
      mockBlobStorage.listObjects.mockResolvedValue({ objects: [{ key: 'a.txt', size: 1 }] });

      await expect(service.listObjects('bucket-1')).resolves.toHaveLength(1);
    });

    it('lets an unscoped platform admin write to a SYSTEM row', async () => {
      mockTenantBucketRepository.findById.mockResolvedValue(platformRow('backups', { bucketType: 'CUSTOM', isSystemBucket: false }));
      mockBlobStorage.putObject.mockResolvedValue(undefined);

      await expect(service.uploadObject('platform-1', 'k.txt', Buffer.from('x'))).resolves.toMatchObject({ key: 'k.txt' });
    });
  });
});
