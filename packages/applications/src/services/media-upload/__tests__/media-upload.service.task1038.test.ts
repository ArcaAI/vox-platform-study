/**
 * TASK-1038 (F1) — `MediaUploadService`: one attachment or audio blob into the TENANT's own bucket,
 * recorded as a `Media` row, answered as `{ mediaId, mime, sizeBytes, sha256 }`.
 *
 *  - the size ceiling comes from the settings plane (`media.upload.maxAttachmentSizeMb` /
 *    `media.upload.maxAudioSizeMb`), never a literal — refused (413) BEFORE any write;
 *  - an attachment's bytes must be what its MIME type says (a PDF starts `%PDF-`, …) — 400;
 *  - the bucket follows the tenant storage cascade: ATTACHMENTS purpose → `attachments` slug for an
 *    attachment, AUDIO purpose → `recordings` → `audio` for audio; none is a named 503, never a
 *    platform bucket (PHI);
 *  - the `Media` row is created through `IMediaService.create` (which audits it); an object whose row
 *    could not be written is removed again;
 *  - `getOwnedReference` is tenant-scoped: another tenant's or an unknown id is the same 404.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY, MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY } from '../../settings-registry/descriptors/media-upload.descriptors';
import { MediaUploadService } from '../media-upload.service';

const TENANT = 'tenant-1';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

let limits: Record<string, number>;
const cls = { get: vi.fn(), set: vi.fn() };
const events = { emit: vi.fn() };
const media = { create: vi.fn() };
const mediaRepository = { findByIdOrNull: vi.fn() };
const buckets = { getBucketByPurpose: vi.fn(), getBucketBySlug: vi.fn() };
const blob = { putObject: vi.fn(), deleteObject: vi.fn() };
const settings = { resolvePlatform: vi.fn((key: string) => ({ key, value: limits[key], source: 'platform' })) };

const build = () =>
  new MediaUploadService(events as never, cls as never, media as never, mediaRepository as never, buckets as never, blob as never, settings as never);

beforeEach(() => {
  vi.clearAllMocks();
  limits = { [MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY]: 25, [MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY]: 250 };
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : undefined));
  buckets.getBucketByPurpose.mockImplementation(async (purpose: string) =>
    purpose === 'ATTACHMENTS' ? { id: 'b-att', name: 'tenant-1-attachments' } : purpose === 'AUDIO' ? { id: 'b-aud', name: 'tenant-1-recordings' } : null,
  );
  buckets.getBucketBySlug.mockResolvedValue(null);
  blob.putObject.mockResolvedValue(undefined);
  blob.deleteObject.mockResolvedValue(undefined);
  media.create.mockImplementation(async (request: Record<string, unknown>) => ({ id: 'media-1', ...request }));
});

describe('upload — an attachment', () => {
  it('stores the bytes in the tenant ATTACHMENTS bucket, records the Media row, and answers the reference', async () => {
    const answer = await build().upload({ category: 'attachment', buffer: PDF, mimeType: 'application/pdf', originalName: '../../etc/labs result.pdf' });

    expect(answer).toEqual({ mediaId: 'media-1', mime: 'application/pdf', sizeBytes: PDF.length, sha256: sha(PDF) });
    const put = blob.putObject.mock.calls[0][0];
    expect(put).toMatchObject({ bucket: 'tenant-1-attachments', body: PDF, contentType: 'application/pdf' });
    expect(put.key).toMatch(/^\d{4}\/\d{2}\/media\/[0-9a-f-]+\/labs_result\.pdf$/);
    expect(media.create).toHaveBeenCalledWith({
      tenantId: TENANT,
      name: 'labs_result.pdf',
      uri: `s3://tenant-1-attachments/${put.key}`,
      extension: 'pdf',
      mimeType: 'application/pdf',
      size: PDF.length,
      hash: sha(PDF),
    });
  });

  it('normalises `image/jpg` and checks the bytes against the MIME type', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    expect((await build().upload({ category: 'attachment', buffer: jpeg, mimeType: 'IMAGE/JPG', originalName: 'x.jpg' })).mime).toBe('image/jpeg');

    const error = await build()
      .upload({ category: 'attachment', buffer: PNG, mimeType: 'application/pdf', originalName: 'fake.pdf' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('MEDIA_CONTENT_MISMATCH');
    expect(blob.putObject).toHaveBeenCalledTimes(1);
  });

  it('refuses a text attachment that is not text (a NUL byte)', async () => {
    const error = await build()
      .upload({ category: 'attachment', buffer: Buffer.from([0x68, 0x00, 0x69]), mimeType: 'text/plain', originalName: 'a.txt' })
      .catch((e: unknown) => e);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('MEDIA_CONTENT_MISMATCH');
  });

  it('refuses a MIME type outside the category (400) and an empty file (400)', async () => {
    await expect(build().upload({ category: 'attachment', buffer: PDF, mimeType: 'application/zip' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().upload({ category: 'attachment', buffer: Buffer.alloc(0), mimeType: 'application/pdf' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(blob.putObject).not.toHaveBeenCalled();
  });

  it('413 over the CONFIGURED ceiling — read from the settings plane — before any write', async () => {
    limits[MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY] = 1;
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1024 * 1024)]);
    const error = await build()
      .upload({ category: 'attachment', buffer: big, mimeType: 'application/pdf' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadTooLargeException);
    expect(((error as PayloadTooLargeException).getResponse() as { code: string }).code).toBe('MEDIA_TOO_LARGE');
    expect(settings.resolvePlatform).toHaveBeenCalledWith(MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY);
    expect(blob.putObject).not.toHaveBeenCalled();
    expect(media.create).not.toHaveBeenCalled();
  });

  it('falls back to the `attachments` slug, and is a named 503 when the tenant has no attachment bucket', async () => {
    buckets.getBucketByPurpose.mockResolvedValue(null);
    buckets.getBucketBySlug.mockImplementation(async (slug: string) => (slug === 'attachments' ? { id: 'b2', name: 'legacy-attachments' } : null));
    await build().upload({ category: 'attachment', buffer: PDF, mimeType: 'application/pdf' });
    expect(blob.putObject.mock.calls[0][0].bucket).toBe('legacy-attachments');

    buckets.getBucketBySlug.mockResolvedValue(null);
    const error = await build()
      .upload({ category: 'attachment', buffer: PDF, mimeType: 'application/pdf' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(((error as ServiceUnavailableException).getResponse() as { code: string }).code).toBe('MEDIA_STORAGE_UNAVAILABLE');
  });

  it('removes the stored object again when the Media row cannot be written', async () => {
    media.create.mockRejectedValueOnce(new Error('db down'));
    await expect(build().upload({ category: 'attachment', buffer: PDF, mimeType: 'application/pdf' })).rejects.toThrow('db down');
    expect(blob.deleteObject).toHaveBeenCalledWith({ bucket: 'tenant-1-attachments', key: blob.putObject.mock.calls[0][0].key });
  });

  it('refuses without a tenant context', async () => {
    cls.get.mockReturnValue(undefined);
    await expect(build().upload({ category: 'attachment', buffer: PDF, mimeType: 'application/pdf' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('upload — audio', () => {
  it('goes to the AUDIO bucket under the audio ceiling', async () => {
    limits[MEDIA_UPLOAD_MAX_ATTACHMENT_SIZE_MB_KEY] = 1;
    const answer = await build().upload({ category: 'audio', buffer: WAV, mimeType: 'audio/wav', originalName: 'dictation.wav' });
    expect(answer).toMatchObject({ mime: 'audio/wav', sizeBytes: WAV.length });
    expect(blob.putObject.mock.calls[0][0].bucket).toBe('tenant-1-recordings');
    expect(settings.resolvePlatform).toHaveBeenCalledWith(MEDIA_UPLOAD_MAX_AUDIO_SIZE_MB_KEY);
  });

  it('falls back to the `recordings` then `audio` slug', async () => {
    buckets.getBucketByPurpose.mockResolvedValue(null);
    buckets.getBucketBySlug.mockImplementation(async (slug: string) => (slug === 'audio' ? { id: 'b3', name: 'legacy-audio' } : null));
    await build().upload({ category: 'audio', buffer: WAV, mimeType: 'audio/wav' });
    expect(buckets.getBucketBySlug.mock.calls.map((call) => call[0])).toEqual(['recordings', 'audio']);
    expect(blob.putObject.mock.calls[0][0].bucket).toBe('legacy-audio');
  });
});

describe('getOwnedReference — 404-over-403', () => {
  it('answers this tenant’s media as a reference, and the same 404 for a foreign or unknown id', async () => {
    mediaRepository.findByIdOrNull.mockImplementation(async (id: string) =>
      id === 'mine'
        ? { id, tenantId: TENANT, mimeType: 'application/pdf', name: 'a.pdf', size: 3, hash: 'abc', uri: 's3://secret' }
        : id === 'theirs'
          ? { id, tenantId: 'tenant-2', mimeType: 'application/pdf', name: 'b.pdf', size: 3, hash: 'def', uri: 's3://secret' }
          : null,
    );
    expect(await build().getOwnedReference('mine')).toEqual({ mediaId: 'mine', mime: 'application/pdf', sizeBytes: 3, sha256: 'abc' });
    await expect(build().getOwnedReference('theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(build().getOwnedReference('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
