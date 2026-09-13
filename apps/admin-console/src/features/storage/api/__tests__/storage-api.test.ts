import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptBucket,
  createAccessKey,
  createBucket,
  deleteAccessKey,
  deleteBucket,
  deleteObject,
  deleteStorageConfig,
  getBucket,
  getBucketDefaults,
  getBucketTree,
  getEffectiveStorageConfig,
  getPresignedUrl,
  listAccessKeys,
  listBuckets,
  listObjects,
  listStorageConfigs,
  provisionTenantBuckets,
  setBucketDefaults,
  uploadObject,
  upsertStorageConfig,
} from '../client';
import { storageKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  rawBody: BodyInit | null | undefined;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        rawBody: init?.body,
      });
      return Response.json({ id: 'b-1' });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storageKeys', () => {
  it('is stable across buckets, objects, configs and keys', () => {
    expect(storageKeys.buckets()).toEqual(storageKeys.buckets());
    expect(storageKeys.objects('b-1', 'audio/')).toEqual(storageKeys.objects('b-1', 'audio/'));
    expect(storageKeys.objects('b-1')).not.toEqual(storageKeys.objects('b-2'));
    expect(storageKeys.tree('b-1')).not.toEqual(storageKeys.objects('b-1'));
    for (const key of [storageKeys.buckets(), storageKeys.defaults(), storageKeys.configs(), storageKeys.accessKeys()]) {
      expect(key[0]).toBe('storage');
    }
  });
});

describe('storage client — buckets', () => {
  it('lists, reads, creates, deletes and provisions buckets', async () => {
    const calls = installFetchMock();
    await listBuckets();
    await getBucket('b-1');
    await createBucket({ slug: 'attachments-eu' });
    await deleteBucket('b-1');
    await provisionTenantBuckets('t-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/tenants/storage/buckets',
      'GET /api/hope/admin/tenants/storage/buckets/b-1',
      'POST /api/hope/admin/tenants/storage/buckets',
      'DELETE /api/hope/admin/tenants/storage/buckets/b-1',
      'POST /api/hope/admin/tenants/storage/buckets/provision/t-1',
    ]);
  });

  // Adoption is a DIFFERENT route from createBucket: that one derives the
  // physical name from tenantKey + slug, this one takes a name that already
  // exists in storage, plus the owning tenant (the caller is unscoped).
  it('posts an adoption to .../buckets/register with the name and owning tenant', async () => {
    const calls = installFetchMock();

    await adoptBucket({ name: 'legacy-exports', tenantId: 't-2', description: 'Migrated exports' });

    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('POST /api/hope/admin/tenants/storage/buckets/register');
    expect(calls[0].body).toEqual({ name: 'legacy-exports', tenantId: 't-2', description: 'Migrated exports' });
  });

  it('round-trips defaults and browses tree/objects/presigned URLs', async () => {
    const calls = installFetchMock();
    await getBucketDefaults();
    await setBucketDefaults({ audioBucketId: 'b-1' });
    await getBucketTree('b-1', 'audio/');
    await listObjects('b-1', 'audio/');
    await getPresignedUrl('b-1', 'audio/a.wav');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/tenants/storage/buckets/defaults',
      'PUT /api/hope/admin/tenants/storage/buckets/defaults',
      'GET /api/hope/admin/tenants/storage/buckets/b-1/tree?prefix=audio%2F',
      'GET /api/hope/admin/tenants/storage/buckets/b-1/objects?prefix=audio%2F',
      'GET /api/hope/admin/tenants/storage/buckets/b-1/presigned-url?key=audio%2Fa.wav',
    ]);
  });

  it('uploads an object as multipart FormData and deletes by key', async () => {
    const calls = installFetchMock();
    const file = new Blob(['audio-bytes']);
    await uploadObject('b-1', 'audio/a.wav', file);
    await deleteObject('b-1', 'audio/a.wav');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/admin/tenants/storage/buckets/b-1/objects?key=audio%2Fa.wav');
    expect(calls[0].rawBody).toBeInstanceOf(FormData);
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toBe('/api/hope/admin/tenants/storage/buckets/b-1/objects?key=audio%2Fa.wav');
  });
});

describe('storage client — config + access keys', () => {
  it('reads/upserts/deletes provider configs', async () => {
    const calls = installFetchMock();
    await listStorageConfigs(true);
    await getEffectiveStorageConfig('b-1');
    await upsertStorageConfig({ provider: 'MINIO' });
    await deleteStorageConfig('cfg-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/tenants/storage/config?includeDisabled=true',
      'GET /api/hope/admin/tenants/storage/config/effective?bucketId=b-1',
      'PUT /api/hope/admin/tenants/storage/config',
      'DELETE /api/hope/admin/tenants/storage/config/cfg-1',
    ]);
  });

  it('lists/creates/revokes scoped access keys', async () => {
    const calls = installFetchMock();
    await listAccessKeys();
    await createAccessKey({ name: 'ingest' });
    await deleteAccessKey('k-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/tenants/storage/keys',
      'POST /api/hope/admin/tenants/storage/keys',
      'DELETE /api/hope/admin/tenants/storage/keys/k-1',
    ]);
  });
});
