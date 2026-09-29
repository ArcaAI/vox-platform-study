/**
 * The media record written after an upload is a documented best-effort side
 * effect: its failure must not fail the upload. It must not be silent either —
 * the object exists in storage with no `Media` row, and that is exactly the
 * orphan someone will later have to explain.
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageController } from '../storage.controller';

const build = (mediaCreate: ReturnType<typeof vi.fn>) => {
  const blobStorage = { putObject: vi.fn().mockResolvedValue(undefined) };
  const tenantBucketService = {
    getBucketByName: vi.fn().mockResolvedValue({ id: 'b1', tenantId: 'tenant-1', name: 'attachments', slug: 'attachments' }),
  };
  const controller = new StorageController(
    blobStorage as any,
    {} as any,
    { create: mediaCreate } as any,
    tenantBucketService as any,
    {} as any,
    { generateWebpThumbnail: vi.fn() } as any,
  );
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  (controller as unknown as { logger: typeof logger }).logger = logger;
  return { controller, logger };
};

const file = {
  fieldname: 'file',
  originalname: 'note.txt',
  mimetype: 'text/plain',
  size: 4,
  buffer: Buffer.from('note'),
} as unknown as Express.Multer.File;

describe('StorageController.uploadFile — media record failure', () => {
  it('still answers the upload, without a mediaId, and logs a warn carrying the Error object and the object key', async () => {
    const failure = new Error('ECONNRESET');
    const { controller, logger } = build(vi.fn().mockRejectedValue(failure));

    const result = await controller.uploadFile('attachments', file, 'note.txt');

    expect(result.key).toBe('note.txt');
    expect(result.mediaId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: failure, bucketName: 'attachments', fileKey: 'note.txt' }));
  });

  it('logs nothing when the media record is created', async () => {
    const { controller, logger } = build(vi.fn().mockResolvedValue({ id: 'media-1' }));

    const result = await controller.uploadFile('attachments', file, 'note.txt');

    expect(result.mediaId).toBe('media-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
