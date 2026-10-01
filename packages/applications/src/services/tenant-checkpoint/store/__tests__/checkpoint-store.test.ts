import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { BlobStorageProviderFactory } from '../../../baseServices/storage/providers/blob-storage.provider.factory';
import type { IBlobStorageProvider } from '../../../baseServices/storage/providers/IBlobStorageProvider';
import { CHECKPOINT_BUCKET } from '../../contracts';
import { CheckpointStore } from '../checkpoint-store';

function fakeProvider(overrides: Partial<Record<keyof IBlobStorageProvider, unknown>> = {}) {
  const uploaded: Buffer[] = [];
  const p = {
    provider: 'MINIO',
    bucketExists: vi.fn().mockResolvedValue(true),
    createBucket: vi.fn().mockResolvedValue(undefined),
    getObjectStream: vi.fn().mockResolvedValue(Readable.from([Buffer.from('x')])),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    presignGet: vi.fn().mockResolvedValue('https://signed/get'),
    putObjectStream: vi.fn(async ({ body }: { body: Readable }) => {
      for await (const c of body) uploaded.push(c as Buffer);
      return { sizeBytes: Buffer.concat(uploaded).length };
    }),
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: 'up-1' }),
    presignUploadPart: vi.fn(async ({ partNumber }: { partNumber: number }) => `https://signed/part/${partNumber}`),
    completeMultipartUpload: vi.fn().mockResolvedValue({ sizeBytes: 123 }),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { p, uploaded };
}

function storeWith(p: unknown) {
  const factory = { getProvider: vi.fn().mockResolvedValue(p) } as unknown as BlobStorageProviderFactory;
  return new CheckpointStore(factory);
}

describe('CheckpointStore', () => {
  it("objectKey('t','c') === 't/c.hcp'", () => {
    expect(storeWith(fakeProvider().p).objectKey('t', 'c')).toBe('t/c.hcp');
  });

  it('objectKey refuses ids that could escape the tenant prefix', () => {
    const s = storeWith(fakeProvider().p);
    expect(() => s.objectKey('../x', 'c')).toThrow();
    expect(() => s.objectKey('t', 'a/b')).toThrow();
  });

  it('presignDownload passes ResponseContentDisposition: attachment; filename="<name>"', async () => {
    const { p } = fakeProvider();
    const url = await storeWith(p).presignDownload('t/c.hcp', 'acme-2026-10-01-c.hcp', 900);
    expect(url).toBe('https://signed/get');
    expect(p.presignGet).toHaveBeenCalledWith({
      bucket: CHECKPOINT_BUCKET,
      key: 't/c.hcp',
      expiresInSeconds: 900,
      responseContentDisposition: 'attachment; filename="acme-2026-10-01-c.hcp"',
    });
  });

  it('presignDownload neutralises quotes and control characters in the filename', async () => {
    const { p } = fakeProvider();
    await storeWith(p).presignDownload('t/c.hcp', 'a"b\r\nc.hcp', 900);
    expect((p.presignGet.mock.calls[0][0] as { responseContentDisposition: string }).responseContentDisposition).toBe('attachment; filename="a_b__c.hcp"');
  });

  it.each([
    ['out of order', [2, 1]],
    ['duplicate', [1, 1]],
    ['empty', []],
    ['gap', [1, 3]],
    ['not starting at 1', [2, 3]],
  ])('completeUpload with parts %s rejects UPLOAD_PARTS_INVALID before calling the provider', async (_label, numbers) => {
    const { p } = fakeProvider();
    const parts = (numbers as number[]).map((partNumber) => ({ partNumber, etag: `"e${partNumber}"` }));
    await expect(storeWith(p).completeUpload('t/c.hcp', 'up-1', parts)).rejects.toMatchObject({ reason: 'UPLOAD_PARTS_INVALID' });
    expect(p.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('completeUpload rejects a part without an etag', async () => {
    const { p } = fakeProvider();
    await expect(storeWith(p).completeUpload('t/c.hcp', 'up-1', [{ partNumber: 1, etag: '' }])).rejects.toMatchObject({ reason: 'UPLOAD_PARTS_INVALID' });
  });

  it('completeUpload with a contiguous list completes and returns the size', async () => {
    const { p } = fakeProvider();
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `"e${partNumber}"` }));
    await expect(storeWith(p).completeUpload('t/c.hcp', 'up-1', parts)).resolves.toEqual({ sizeBytes: 123 });
    expect(p.completeMultipartUpload).toHaveBeenCalledWith({ bucket: CHECKPOINT_BUCKET, key: 't/c.hcp', uploadId: 'up-1', parts });
  });

  it('ensureBucket calls createBucket only when bucketExists is false', async () => {
    const a = fakeProvider();
    await storeWith(a.p).ensureBucket();
    expect(a.p.createBucket).not.toHaveBeenCalled();
    const b = fakeProvider({ bucketExists: vi.fn().mockResolvedValue(false) });
    await storeWith(b.p).ensureBucket();
    expect(b.p.createBucket).toHaveBeenCalledWith(CHECKPOINT_BUCKET);
  });

  it('createUpload + presignUploadParts return the upload id and one URL per part', async () => {
    const { p } = fakeProvider();
    const s = storeWith(p);
    expect(await s.createUpload('t/c.hcp')).toEqual({ uploadId: 'up-1' });
    const urls = await s.presignUploadParts('t/c.hcp', 'up-1', 3, 600);
    expect(urls).toEqual([1, 2, 3].map((n) => ({ partNumber: n, url: `https://signed/part/${n}` })));
    expect(p.presignUploadPart).toHaveBeenCalledWith({ bucket: CHECKPOINT_BUCKET, key: 't/c.hcp', uploadId: 'up-1', partNumber: 2, expiresInSeconds: 600 });
    await expect(s.presignUploadParts('t/c.hcp', 'up-1', 0, 600)).rejects.toThrow();
    // exact signed ContentLength per part: full parts, then the remainder
    p.presignUploadPart.mockClear();
    await s.presignUploadParts('t/c.hcp', 'up-1', 3, 600, { sizeBytes: 250, partSizeBytes: 100 });
    expect(p.presignUploadPart.mock.calls.map(([a]) => (a as { contentLength: number }).contentLength)).toEqual([100, 100, 50]);
    await expect(s.presignUploadParts('t/c.hcp', 'up-1', 10001, 600)).rejects.toThrow();
  });

  it('openWriteStream streams into putObjectStream and resolves done with the size', async () => {
    const { p, uploaded } = fakeProvider();
    const w = storeWith(p).openWriteStream('t/c.hcp');
    w.stream.write(Buffer.from('hello '));
    w.stream.end(Buffer.from('world'));
    await expect(w.done).resolves.toEqual({ sizeBytes: 11 });
    expect(Buffer.concat(uploaded).toString()).toBe('hello world');
  });

  it('openWriteStream destroys the stream when the upload fails, so a writer never blocks', async () => {
    const { p } = fakeProvider({ putObjectStream: vi.fn().mockRejectedValue(new Error('s3 down')) });
    const w = storeWith(p).openWriteStream('t/c.hcp');
    await expect(w.done).rejects.toThrow(/s3 down/);
    expect(w.stream.destroyed).toBe(true);
  });

  it('abort() signals the provider and settles', async () => {
    let seen: AbortSignal | undefined;
    const { p } = fakeProvider({
      putObjectStream: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        seen = signal;
        await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }),
    });
    const w = storeWith(p).openWriteStream('t/c.hcp');
    await new Promise((r) => setImmediate(r));
    await w.abort();
    expect(seen?.aborted).toBe(true);
    await expect(w.done).rejects.toThrow(/aborted/);
  });

  it('a provider without multipart support is refused clearly', async () => {
    const { p } = fakeProvider({ createMultipartUpload: undefined });
    await expect(storeWith(p).createUpload('t/c.hcp')).rejects.toThrow(/S3-only/);
  });
});
