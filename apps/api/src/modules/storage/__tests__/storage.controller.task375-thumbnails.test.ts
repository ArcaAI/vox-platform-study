/**
 * TASK-375 (thumbnails) — generate-on-upload image derivatives.
 *
 * When an IMAGE is uploaded via `StorageController.uploadFile`, the controller
 * also produces a real downscaled WebP thumbnail and stores it at the
 * deterministic derived key (`<key>.thumb.webp`) so the context timeline can
 * presign a genuinely smaller thumbnail (no schema change). The work is
 * best-effort: a thumbnail failure must never fail the upload, and non-images
 * must never trigger generation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageController } from '../storage.controller';

const mockBlobStorage = {
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
  listObjects: vi.fn(),
  putObject: vi.fn(),
  presignGet: vi.fn(),
  deleteObject: vi.fn(),
};

const mockS3Service = { listAllBuckets: vi.fn(), updateBucket: vi.fn() };
const mockMediaService = { create: vi.fn() };
const mockTenantBucketService = {
  listBuckets: vi.fn(),
  getBucketByName: vi.fn(),
  getBucketBySlug: vi.fn(),
  registerBucket: vi.fn(),
};
const mockS3HealthService = { checkHealth: vi.fn() };
const mockImageThumbnailService = { generateWebpThumbnail: vi.fn() };

const createMockBucketResponse = () => ({
  id: 'bucket-1',
  tenantId: 'tenant-1',
  name: 'attachments',
  slug: 'attachments',
  createdAt: '2026-06-27T00:00:00.000Z',
});

const createMockFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'scan.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 2048,
    buffer: Buffer.from('original-image-bytes'),
    ...overrides,
  }) as unknown as Express.Multer.File;

describe('TASK-375 — StorageController image thumbnail generation on upload', () => {
  let controller: StorageController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new StorageController(
      mockBlobStorage as any,
      mockS3Service as any,
      mockMediaService as any,
      mockTenantBucketService as any,
      mockS3HealthService as any,
      mockImageThumbnailService as any,
    );
    mockTenantBucketService.getBucketByName.mockResolvedValue(createMockBucketResponse());
    mockBlobStorage.putObject.mockResolvedValue(undefined);
  });

  it('generates a WebP derivative and stores it at the deterministic derived key', async () => {
    mockMediaService.create.mockResolvedValue({ id: 'media-img' });
    const thumbBytes = Buffer.from('webp-thumbnail-bytes');
    mockImageThumbnailService.generateWebpThumbnail.mockResolvedValue(thumbBytes);

    const file = createMockFile({ originalname: 'scan.png', mimetype: 'image/png' });
    const result = await controller.uploadFile('attachments', file, 'scan.png');

    // Original object stored exactly as before.
    expect(mockBlobStorage.putObject).toHaveBeenCalledWith({
      bucket: 'attachments',
      key: 'scan.png',
      body: file.buffer,
      contentType: 'image/png',
    });
    // Derivative generated from the uploaded bytes...
    expect(mockImageThumbnailService.generateWebpThumbnail).toHaveBeenCalledWith(file.buffer);
    // ...and stored at `<key>.thumb.webp` as image/webp.
    expect(mockBlobStorage.putObject).toHaveBeenCalledWith({
      bucket: 'attachments',
      key: 'scan.png.thumb.webp',
      body: thumbBytes,
      contentType: 'image/webp',
    });
    // Media row still references the ORIGINAL (no new row for the derivative).
    expect(mockMediaService.create).toHaveBeenCalledWith(expect.objectContaining({ uri: 's3://attachments/scan.png' }));
    expect(result.mediaId).toBe('media-img');
  });

  it('does NOT generate a thumbnail for a non-image upload', async () => {
    mockMediaService.create.mockResolvedValue({ id: 'media-pdf' });

    const file = createMockFile({ originalname: 'report.pdf', mimetype: 'application/pdf', buffer: Buffer.from('pdf') });
    await controller.uploadFile('attachments', file, 'report.pdf');

    expect(mockImageThumbnailService.generateWebpThumbnail).not.toHaveBeenCalled();
    // Only the original object is written.
    expect(mockBlobStorage.putObject).toHaveBeenCalledTimes(1);
  });

  it('still succeeds (best-effort) when thumbnail generation throws', async () => {
    mockMediaService.create.mockResolvedValue({ id: 'media-img2' });
    mockImageThumbnailService.generateWebpThumbnail.mockRejectedValue(new Error('unsupported image'));

    const file = createMockFile({ originalname: 'bad.png', mimetype: 'image/png', buffer: Buffer.from('x') });
    const result = await controller.uploadFile('attachments', file, 'bad.png');

    // Upload + media row succeed despite the thumbnail failure.
    expect(result.mediaId).toBe('media-img2');
    expect(mockBlobStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ key: 'bad.png' }));
    // The derivative was never stored (generation failed before putObject).
    expect(mockBlobStorage.putObject).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'bad.png.thumb.webp' }));
  });
});
