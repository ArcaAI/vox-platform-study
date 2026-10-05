/**
 * Storage primitives for the direct-to-store attachment upload flow: a presigned PUT that signs the
 * content type and length, a head/range read of what the client actually wrote, and a quota gate
 * that can be asked up front and kept honest after a PUT the gateway never saw.
 *
 * The S3 signer is NOT mocked: what matters is which headers the real signature covers.
 */
import { Readable } from 'node:stream';
import { StorageProvider } from '@arcaai/types';
import { QuotaExceededException } from '@arcaai/exceptions';
import { ResourceStatusType, TenantPlan } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStorageService } from '../blob-storage.service';
import { TenantBucketStorageGate } from '../tenant-bucket-storage.gate';
import { S3BlobProvider } from '../providers/s3-blob.provider';
import { AzureBlobProvider } from '../providers/azure-blob.provider';

const TENANT = 'tenant-acme';
const ATTACHMENTS = { name: 'hope-attachments-acme', tenantId: TENANT, bucketType: 'SYSTEM', resourceStatus: ResourceStatusType.ENABLED };

describe('S3BlobProvider — presignPutIntent / headObject / getObjectRange', () => {
  const s3 = () =>
    new S3BlobProvider({
      endpoint: 'https://hope-minio:9000',
      publicEndpoint: 'https://files.example.com',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      forcePathStyle: true,
      provider: StorageProvider.MINIO,
    });
  const checksum = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';

  it('signs content-type and content-length, and sends the checksum as a required header', async () => {
    const out = await s3().presignPutIntent({
      bucket: 'b', key: 'k.pdf', contentType: 'application/pdf', contentLength: 1234, checksumSha256: checksum, expiresSeconds: 300,
    });
    const url = new URL(out.url);
    expect(url.host).toBe('files.example.com');
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'x-amz-checksum-sha256']));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(out.headers).toEqual({ 'Content-Type': 'application/pdf', 'Content-Length': '1234', 'x-amz-checksum-sha256': checksum });
    // bucket default SSE: no per-request SSE header
    expect(JSON.stringify(out)).not.toMatch(/server-side-encryption/i);
  });

  it('omits the checksum header when none is given', async () => {
    const out = await s3().presignPutIntent({ bucket: 'b', key: 'k', contentType: 'image/png', contentLength: 10, expiresSeconds: 60 });
    expect(out.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '10' });
    expect(new URL(out.url).searchParams.get('X-Amz-SignedHeaders')).not.toContain('x-amz-checksum-sha256');
  });

  it('headObject maps the store answer, and returns null for a missing key', async () => {
    const provider = s3();
    const send = vi.fn()
      .mockResolvedValueOnce({ ContentLength: 42, ContentType: 'audio/wav', ETag: '"abc"', ChecksumSHA256: checksum })
      .mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    (provider as unknown as { client: { send: typeof send } }).client = { send };
    await expect(provider.headObject({ bucket: 'b', key: 'k' })).resolves.toEqual({
      sizeBytes: 42, contentType: 'audio/wav', etag: 'abc', checksumSha256: checksum,
    });
    await expect(provider.headObject({ bucket: 'b', key: 'gone' })).resolves.toBeNull();
  });

  it('getObjectRange issues an inclusive Range request', async () => {
    const provider = s3();
    const send = vi.fn().mockResolvedValue({ Body: Readable.from([Buffer.from([1, 2, 3])]) });
    (provider as unknown as { client: { send: typeof send } }).client = { send };
    const buf = await provider.getObjectRange({ bucket: 'b', key: 'k', start: 0, end: 2 });
    expect([...buf]).toEqual([1, 2, 3]);
    expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'b', Key: 'k', Range: 'bytes=0-2' });
  });
});

describe('AzureBlobProvider — presignPutIntent', () => {
  it('returns a SAS URL with the same TTL, content-type header and no checksum header', async () => {
    const provider = new AzureBlobProvider({
      accountName: 'acct', accountKey: Buffer.from('key').toString('base64'), provider: StorageProvider.AZURE_BLOB,
    } as never);
    const out = await provider.presignPutIntent({
      bucket: 'c', key: 'k', contentType: 'application/pdf', contentLength: 5, checksumSha256: 'ignored', expiresSeconds: 300,
    });
    expect(new URL(out.url).searchParams.get('sig')).toBeTruthy();
    expect(out.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(out.headers['Content-Type']).toBe('application/pdf');
    expect(out.headers['x-amz-checksum-sha256']).toBeUndefined();
  });
});

describe('BlobStorageService — presigned-intent facade', () => {
  const bucketRepo = { findAll: vi.fn(), findSystemBuckets: vi.fn() };
  const tenantRepo = { findById: vi.fn() };
  const planRepo = { findByPlan: vi.fn() };
  const overrideRepo = { findByTenant: vi.fn() };
  const appSettings = { getValueWithDefault: vi.fn((_k: string, d: unknown) => d) };
  const factory = { getProviderForBucket: vi.fn() };
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _t: number, v: string) => void store.set(k, v)),
    del: vi.fn(),
    eval: vi.fn(async (_s: string, _n: number, k: string, amt: string | number) => {
      if (!store.has(k)) return null;
      store.set(k, String(Number(store.get(k)) + Number(amt)));
      return store.get(k);
    }),
  };
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let service: BlobStorageService;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    provider = {
      listObjects: vi.fn(async () => ({ objects: [{ key: 'a', size: 700 }], isTruncated: false })),
      headObject: vi.fn().mockResolvedValue({ sizeBytes: 5, contentType: 'x', etag: 'e' }),
      getObjectRange: vi.fn().mockResolvedValue(Buffer.from([1])),
      presignPutIntent: vi.fn().mockResolvedValue({ url: 'https://signed', headers: { 'Content-Type': 'x' } }),
    };
    factory.getProviderForBucket.mockResolvedValue(provider);
    bucketRepo.findAll.mockResolvedValue([ATTACHMENTS]);
    bucketRepo.findSystemBuckets.mockResolvedValue([ATTACHMENTS]);
    tenantRepo.findById.mockResolvedValue({ id: TENANT, plan: TenantPlan.STARTER });
    planRepo.findByPlan.mockResolvedValue(null);
    overrideRepo.findByTenant.mockResolvedValue({ storageQuotaBytes: BigInt(1000) });
    const gate = new TenantBucketStorageGate(
      bucketRepo as never, tenantRepo as never, planRepo as never, overrideRepo as never,
      appSettings as never, factory as never, { emit: vi.fn() } as never, redis as never,
    );
    service = new BlobStorageService(factory as never, { get: () => TENANT } as never, gate);
  });

  it('passes headObject and getObjectRange through to the tenant bucket provider', async () => {
    await expect(service.headObject('b', 'k')).resolves.toMatchObject({ sizeBytes: 5 });
    await service.getObjectRange('b', 'k', 0, 7);
    expect(provider.headObject).toHaveBeenCalledWith({ bucket: 'b', key: 'k' });
    expect(provider.getObjectRange).toHaveBeenCalledWith({ bucket: 'b', key: 'k', start: 0, end: 7 });
  });

  it('presignPutIntent asserts the declared size against quota, then delegates', async () => {
    const params = { bucket: ATTACHMENTS.name, key: 'k', contentType: 'x', contentLength: 200, expiresSeconds: 60 };
    await expect(service.presignPutIntent(params)).resolves.toEqual({ url: 'https://signed', headers: { 'Content-Type': 'x' } });
    expect(provider.presignPutIntent).toHaveBeenCalledWith(params);

    provider.presignPutIntent.mockClear();
    await expect(service.presignPutIntent({ ...params, contentLength: 301 })).rejects.toBeInstanceOf(QuotaExceededException);
    expect(provider.presignPutIntent).not.toHaveBeenCalled();
  });

  it('assertCanStore calls the tenant storage quota gate with the byte count', async () => {
    await expect(service.assertCanStore(ATTACHMENTS.name, 300)).resolves.toBeUndefined();
    await expect(service.assertCanStore(ATTACHMENTS.name, 301)).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('recordExternalWrite adds a client-direct PUT to the cached usage', async () => {
    await service.assertCanStore(ATTACHMENTS.name, 1); // measures + caches 700
    expect(store.get(`tenant-storage-usage:${TENANT}`)).toBe('700');
    await service.recordExternalWrite(ATTACHMENTS.name, 250);
    expect(store.get(`tenant-storage-usage:${TENANT}`)).toBe('950');
    await expect(service.assertCanStore(ATTACHMENTS.name, 51)).rejects.toBeInstanceOf(QuotaExceededException);
  });
});
