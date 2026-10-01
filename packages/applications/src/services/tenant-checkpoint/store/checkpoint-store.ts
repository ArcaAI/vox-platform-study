/**
 * The only code that touches the `hope-tenant-checkpoints` bucket. Always the PLATFORM provider
 * (`BlobStorageProviderFactory.getProvider()`), never a tenant's — a checkpoint must survive the
 * tenant's own storage being reconfigured or restored.
 */
import { PassThrough, Readable, Writable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';

import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import type { IBlobStorageProvider } from '../../baseServices/storage/providers/IBlobStorageProvider';
import { CHECKPOINT_BUCKET, CheckpointError, type ICheckpointStore } from '../contracts';

const MAX_UPLOAD_PARTS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9-]+$/;

type MultipartProvider = Required<
  Pick<IBlobStorageProvider, 'putObjectStream' | 'createMultipartUpload' | 'presignUploadPart' | 'completeMultipartUpload' | 'abortMultipartUpload'>
>;

function multipart<K extends keyof MultipartProvider>(p: IBlobStorageProvider, method: K): MultipartProvider[K] {
  const fn = p[method];
  if (typeof fn !== 'function') throw new Error('checkpoint multipart is S3-only');
  return (fn as MultipartProvider[K]).bind(p) as MultipartProvider[K];
}

/** RFC 6266 quoted-string safe: no quotes, backslashes, control or non-ASCII characters. */
function safeFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\]/g, '_');
}

function partsInvalid(message: string): CheckpointError {
  return new CheckpointError('UPLOAD_PARTS_INVALID', message);
}

@Injectable()
export class CheckpointStore implements ICheckpointStore {
  constructor(@Inject(BlobStorageProviderFactory) private readonly factory: BlobStorageProviderFactory) {}

  private provider(): Promise<IBlobStorageProvider> {
    return this.factory.getProvider();
  }

  async ensureBucket(): Promise<void> {
    const p = await this.provider();
    if (!(await p.bucketExists(CHECKPOINT_BUCKET))) await p.createBucket(CHECKPOINT_BUCKET);
  }

  objectKey(tenantId: string, checkpointId: string): string {
    if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(checkpointId)) throw new Error('invalid tenant or checkpoint id for an object key');
    return `${tenantId}/${checkpointId}.hcp`;
  }

  openWriteStream(key: string): { stream: Writable; done: Promise<{ sizeBytes: number }>; abort(): Promise<void> } {
    const stream = new PassThrough();
    // The upload's failure is reported through `done`; this listener only stops the same error,
    // re-emitted on the stream below, from becoming an uncaught exception when no writer listens.
    stream.on('error', () => undefined);
    const controller = new AbortController();
    const done = (async () => {
      const p = await this.provider();
      return multipart(p, 'putObjectStream')({
        bucket: CHECKPOINT_BUCKET,
        key,
        body: stream,
        contentType: 'application/octet-stream',
        signal: controller.signal,
      });
    })();
    // A failed upload must unblock the writer: a PassThrough nobody reads would hold it on 'drain' forever.
    done.catch((error: unknown) => {
      if (!stream.destroyed) stream.destroy(error as Error);
    });
    return {
      stream,
      done,
      abort: async () => {
        controller.abort();
        if (!stream.destroyed) stream.destroy();
        await done.catch(() => undefined);
      },
    };
  }

  async openReadStream(key: string): Promise<Readable> {
    return (await this.provider()).getObjectStream({ bucket: CHECKPOINT_BUCKET, key });
  }

  async presignDownload(key: string, filename: string, ttlSeconds: number): Promise<string> {
    return (await this.provider()).presignGet({
      bucket: CHECKPOINT_BUCKET,
      key,
      expiresInSeconds: ttlSeconds,
      responseContentDisposition: `attachment; filename="${safeFilename(filename)}"`,
    });
  }

  async createUpload(key: string): Promise<{ uploadId: string }> {
    const p = await this.provider();
    return multipart(p, 'createMultipartUpload')({ bucket: CHECKPOINT_BUCKET, key, contentType: 'application/octet-stream' });
  }

  async presignUploadParts(key: string, uploadId: string, partCount: number, ttlSeconds: number): Promise<{ partNumber: number; url: string }[]> {
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_UPLOAD_PARTS) {
      throw new Error(`partCount must be an integer in 1..${MAX_UPLOAD_PARTS}`);
    }
    const p = await this.provider();
    const presign = multipart(p, 'presignUploadPart');
    const out: { partNumber: number; url: string }[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      out.push({ partNumber, url: await presign({ bucket: CHECKPOINT_BUCKET, key, uploadId, partNumber, expiresInSeconds: ttlSeconds }) });
    }
    return out;
  }

  /**
   * The part list comes from the browser, so it is checked BEFORE S3 sees it: non-empty,
   * numbered 1..n with no gap, duplicate or reordering, each with an ETag.
   */
  async completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ sizeBytes: number }> {
    if (!Array.isArray(parts) || parts.length === 0) throw partsInvalid('The upload has no parts');
    if (parts.length > MAX_UPLOAD_PARTS) throw partsInvalid(`An upload has at most ${MAX_UPLOAD_PARTS} parts`);
    parts.forEach((part, i) => {
      if (part?.partNumber !== i + 1) throw partsInvalid(`Part ${i + 1} is missing, duplicated or out of order`);
      if (typeof part.etag !== 'string' || part.etag.trim().length === 0) throw partsInvalid(`Part ${i + 1} has no ETag`);
    });
    const p = await this.provider();
    return multipart(p, 'completeMultipartUpload')({ bucket: CHECKPOINT_BUCKET, key, uploadId, parts });
  }

  async abortUpload(key: string, uploadId: string): Promise<void> {
    const p = await this.provider();
    await multipart(p, 'abortMultipartUpload')({ bucket: CHECKPOINT_BUCKET, key, uploadId });
  }

  async delete(key: string): Promise<void> {
    await (await this.provider()).deleteObject({ bucket: CHECKPOINT_BUCKET, key });
  }
}
