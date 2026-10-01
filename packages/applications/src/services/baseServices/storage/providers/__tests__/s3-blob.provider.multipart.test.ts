/**
 * S3BlobProvider — streaming put and browser multipart. AWS SDK mocked at the boundary.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';

let mockSend: Mock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = (...args: unknown[]) => mockSend(...args);
  }
  const cmd = (name: string) =>
    vi.fn(function (this: Record<string, unknown>, input: unknown) {
      this.__name = name;
      this.input = input;
    });
  return {
    S3Client: MockS3Client,
    PutObjectCommand: cmd('PutObject'),
    GetObjectCommand: cmd('GetObject'),
    DeleteObjectCommand: cmd('DeleteObject'),
    ListObjectsV2Command: cmd('ListObjectsV2'),
    CreateBucketCommand: cmd('CreateBucket'),
    DeleteBucketCommand: cmd('DeleteBucket'),
    HeadBucketCommand: cmd('HeadBucket'),
    HeadObjectCommand: cmd('HeadObject'),
    ListBucketsCommand: cmd('ListBuckets'),
    PutBucketLifecycleConfigurationCommand: cmd('PutBucketLifecycleConfiguration'),
    CreateMultipartUploadCommand: cmd('CreateMultipartUpload'),
    UploadPartCommand: cmd('UploadPart'),
    CompleteMultipartUploadCommand: cmd('CompleteMultipartUpload'),
    AbortMultipartUploadCommand: cmd('AbortMultipartUpload'),
  };
});

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://signed.example.com/url');
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...a: unknown[]) => mockGetSignedUrl(...a) }));

import { S3BlobProvider } from '../s3-blob.provider';

type Sent = { __name: string; input: Record<string, unknown> };
const sent = () => mockSend.mock.calls.map((c) => c[0] as Sent);

function provider() {
  return new S3BlobProvider({ endpoint: 'http://minio:9000', publicEndpoint: 'https://files.example.com', accessKeyId: 'a', secretAccessKey: 's' });
}

describe('S3BlobProvider multipart', () => {
  beforeEach(() => {
    mockSend = vi.fn(async (c: Sent) => {
      if (c.__name === 'CreateMultipartUpload') return { UploadId: 'u1' };
      if (c.__name === 'UploadPart') return { ETag: `"etag-${String(c.input.PartNumber)}"` };
      if (c.__name === 'HeadObject') return { ContentLength: 4242 };
      return {};
    });
    mockGetSignedUrl.mockClear();
  });

  it('putObjectStream sends a small stream as one PutObject', async () => {
    const r = await provider().putObjectStream({ bucket: 'b', key: 'k', body: Readable.from([Buffer.from('ab'), Buffer.from('c')]), partSizeBytes: 5 * 1024 * 1024 });
    expect(r).toEqual({ sizeBytes: 3 });
    expect(sent().map((c) => c.__name)).toEqual(['PutObject']);
    expect((sent()[0].input.Body as Buffer).toString()).toBe('abc');
  });

  it('putObjectStream switches to multipart once a part fills, in order, and completes', async () => {
    const part = 5 * 1024 * 1024;
    const chunks = [Buffer.alloc(part - 1, 1), Buffer.alloc(2, 2), Buffer.alloc(part, 3), Buffer.alloc(10, 4)];
    const r = await provider().putObjectStream({ bucket: 'b', key: 'k', body: Readable.from(chunks), partSizeBytes: part });
    expect(r).toEqual({ sizeBytes: 2 * part + 11 });
    const names = sent().map((c) => c.__name);
    expect(names).toEqual(['CreateMultipartUpload', 'UploadPart', 'UploadPart', 'UploadPart', 'CompleteMultipartUpload']);
    const parts = sent().filter((c) => c.__name === 'UploadPart');
    expect(parts.map((c) => [c.input.PartNumber, (c.input.Body as Buffer).length])).toEqual([
      [1, part],
      [2, part],
      [3, 11],
    ]);
    expect((sent()[4].input.MultipartUpload as { Parts: unknown[] }).Parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ]);
  });

  it('putObjectStream aborts the multipart upload when the source fails', async () => {
    const part = 5 * 1024 * 1024;
    async function* src() {
      yield Buffer.alloc(part + 1);
      throw new Error('source broke');
    }
    await expect(provider().putObjectStream({ bucket: 'b', key: 'k', body: Readable.from(src()), partSizeBytes: part })).rejects.toThrow(/source broke/);
    expect(sent().map((c) => c.__name)).toContain('AbortMultipartUpload');
    expect(sent().map((c) => c.__name)).not.toContain('CompleteMultipartUpload');
  });

  it('createMultipartUpload / presignUploadPart / completeMultipartUpload / abortMultipartUpload', async () => {
    const p = provider();
    expect(await p.createMultipartUpload({ bucket: 'b', key: 'k' })).toEqual({ uploadId: 'u1' });
    expect(await p.presignUploadPart({ bucket: 'b', key: 'k', uploadId: 'u1', partNumber: 2, expiresInSeconds: 600 })).toBe('https://signed.example.com/url');
    const [, command, opts] = mockGetSignedUrl.mock.calls[0] as [unknown, Sent, { expiresIn: number }];
    expect(command.__name).toBe('UploadPart');
    expect(command.input).toEqual({ Bucket: 'b', Key: 'k', UploadId: 'u1', PartNumber: 2 });
    expect(opts.expiresIn).toBe(600);
    const res = await p.completeMultipartUpload({ bucket: 'b', key: 'k', uploadId: 'u1', parts: [{ partNumber: 1, etag: '"x"' }] });
    expect(res).toEqual({ sizeBytes: 4242 });
    await p.abortMultipartUpload({ bucket: 'b', key: 'k', uploadId: 'u1' });
    expect(sent().map((c) => c.__name)).toEqual(['CreateMultipartUpload', 'CompleteMultipartUpload', 'HeadObject', 'AbortMultipartUpload']);
  });

  it('presignGet forwards ResponseContentDisposition', async () => {
    await provider().presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 60, responseContentDisposition: 'attachment; filename="x.hcp"' });
    const [, command] = mockGetSignedUrl.mock.calls[0] as [unknown, Sent];
    expect(command.input).toMatchObject({ ResponseContentDisposition: 'attachment; filename="x.hcp"', ResponseCacheControl: 'private, no-store' });
  });
});
