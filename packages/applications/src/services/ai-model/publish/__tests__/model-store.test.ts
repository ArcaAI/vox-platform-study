/**
 * TASK-1019 lane P — `ModelStore`, the model publisher's own view of the
 * `hope-models` bucket (P1, P2, P8 + the multipart upload path).
 *
 * The S3 client is a fake whose `send` dispatches on the REAL command classes
 * from `@aws-sdk/client-s3` (no module mock), so each assertion reads the
 * exact `input` the SDK would put on the wire.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { MODEL_STORE_CREDENTIAL_MISSING, ModelPublisherError, ModelStoreFactory, S3ModelStore } from '../model-store';

type Sent = { name: string; input: Record<string, unknown> };

function fakeClient(handler: (cmd: { input: Record<string, unknown> }, name: string) => unknown) {
  const sent: Sent[] = [];
  return {
    sent,
    send: vi.fn(async (cmd: { input: Record<string, unknown>; constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      return handler(cmd, name);
    }),
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

describe('S3ModelStore', () => {
  describe('listPrefix (P1)', () => {
    it('follows ContinuationToken across three pages', async () => {
      const client = fakeClient((cmd) => {
        const token = cmd.input.ContinuationToken;
        if (!token) return { Contents: [{ Key: 'm/a', Size: 1 }], IsTruncated: true, NextContinuationToken: 't1' };
        if (token === 't1') return { Contents: [{ Key: 'm/b', Size: 2 }], IsTruncated: true, NextContinuationToken: 't2' };
        return { Contents: [{ Key: 'm/c', Size: 3 }], IsTruncated: false };
      });
      const store = new S3ModelStore(client, 'hope-models');

      const items = await collect(store.listPrefix('m/'));

      expect(items).toEqual([
        { key: 'm/a', size: 1 },
        { key: 'm/b', size: 2 },
        { key: 'm/c', size: 3 },
      ]);
      expect(client.sent.map((s) => s.input.ContinuationToken)).toEqual([undefined, 't1', 't2']);
      expect(client.sent.every((s) => s.name === ListObjectsV2Command.name && s.input.Bucket === 'hope-models' && s.input.Prefix === 'm/')).toBe(true);
    });
  });

  describe('deletePrefix (P2)', () => {
    it('purge=false batches DeleteObjects at ≤ 1000 CURRENT keys (the versioned bucket keeps delete markers)', async () => {
      const keys = Array.from({ length: 2500 }, (_, i) => ({ Key: `slug/v1/f${i}`, Size: 1 }));
      const client = fakeClient((cmd, name) => {
        if (name === ListObjectsV2Command.name) {
          const start = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
          const page = keys.slice(start, start + 1000);
          const next = start + 1000;
          return { Contents: page, IsTruncated: next < keys.length, NextContinuationToken: String(next) };
        }
        return { Deleted: [] };
      });
      const store = new S3ModelStore(client, 'hope-models');

      const result = await store.deletePrefix('slug/v1/', { purge: false });

      const deletes = client.sent.filter((s) => s.name === DeleteObjectsCommand.name);
      const batchSizes = deletes.map((d) => (d.input.Delete as { Objects: unknown[] }).Objects.length);
      expect(batchSizes.every((n) => n <= 1000)).toBe(true);
      expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(2500);
      // No VersionId: a plain delete leaves a marker that ILM reclaims (the 30-day undo).
      const objects = deletes.flatMap((d) => (d.input.Delete as { Objects: Array<Record<string, unknown>> }).Objects);
      expect(objects.every((o) => o.VersionId === undefined)).toBe(true);
      expect(client.sent.some((s) => s.name === ListObjectVersionsCommand.name)).toBe(false);
      expect(result).toEqual({ objects: 2500, versions: 0 });
    });

    it('purge=true pages ListObjectVersions and deletes every VersionId, delete markers included', async () => {
      const client = fakeClient((cmd, name) => {
        if (name === ListObjectVersionsCommand.name) {
          if (!cmd.input.KeyMarker) {
            return {
              Versions: [
                { Key: 'p/a', VersionId: 'a2', IsLatest: true },
                { Key: 'p/a', VersionId: 'a1', IsLatest: false },
              ],
              DeleteMarkers: [{ Key: 'p/gone', VersionId: 'dm1', IsLatest: true }],
              IsTruncated: true,
              NextKeyMarker: 'p/a',
              NextVersionIdMarker: 'a1',
            };
          }
          return { Versions: [{ Key: 'p/b', VersionId: 'b1', IsLatest: true }], DeleteMarkers: [], IsTruncated: false };
        }
        return { Deleted: [] };
      });
      const store = new S3ModelStore(client, 'hope-models');

      const result = await store.deletePrefix('p/', { purge: true });

      const listCalls = client.sent.filter((s) => s.name === ListObjectVersionsCommand.name);
      expect(listCalls).toHaveLength(2);
      expect(listCalls[1].input).toMatchObject({ Prefix: 'p/', KeyMarker: 'p/a', VersionIdMarker: 'a1' });
      const deleted = client.sent
        .filter((s) => s.name === DeleteObjectsCommand.name)
        .flatMap((d) => (d.input.Delete as { Objects: Array<{ Key: string; VersionId?: string }> }).Objects);
      expect(deleted).toEqual(
        expect.arrayContaining([
          { Key: 'p/a', VersionId: 'a2' },
          { Key: 'p/a', VersionId: 'a1' },
          { Key: 'p/gone', VersionId: 'dm1' },
          { Key: 'p/b', VersionId: 'b1' },
        ]),
      );
      expect(deleted).toHaveLength(4);
      expect(result).toEqual({ objects: 2, versions: 4 });
    });

    it('refuses an empty, root or non-directory prefix before any request', async () => {
      const client = fakeClient(() => ({}));
      const store = new S3ModelStore(client, 'hope-models');

      for (const prefix of ['', '/', 'slug', 'hf/', 'hf/hub/']) {
        await expect(store.deletePrefix(prefix, { purge: false })).rejects.toThrow(/prefix/i);
      }
      expect(client.send).not.toHaveBeenCalled();
    });

    it('fails when S3 reports per-key delete errors instead of claiming success', async () => {
      const client = fakeClient((_cmd, name) => {
        if (name === ListObjectsV2Command.name) return { Contents: [{ Key: 'p/a', Size: 1 }], IsTruncated: false };
        return { Errors: [{ Key: 'p/a', Code: 'AccessDenied', Message: 'denied' }] };
      });
      const store = new S3ModelStore(client, 'hope-models');

      await expect(store.deletePrefix('p/', { purge: false })).rejects.toThrow(/AccessDenied/);
    });
  });

  describe('headObject / putSmall', () => {
    it('returns the size, and null for a missing key', async () => {
      const client = fakeClient((cmd) => {
        if (cmd.input.Key === 'present') return { ContentLength: 42 };
        throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      });
      const store = new S3ModelStore(client, 'hope-models');

      expect(await store.headObject('present')).toEqual({ size: 42 });
      expect(await store.headObject('absent')).toBeNull();
      expect(client.sent.every((s) => s.name === HeadObjectCommand.name)).toBe(true);
    });

    it('rethrows a head error that is not a 404', async () => {
      const client = fakeClient(() => {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      });
      await expect(new S3ModelStore(client, 'hope-models').headObject('k')).rejects.toThrow('AccessDenied');
    });

    it('putSmall writes the exact bytes (refs/main keeps no trailing newline)', async () => {
      const client = fakeClient(() => ({}));
      await new S3ModelStore(client, 'hope-models').putSmall('hf/hub/models--o--n/refs/main', 'abc123');

      expect(client.sent[0].name).toBe(PutObjectCommand.name);
      expect(client.sent[0].input).toMatchObject({ Bucket: 'hope-models', Key: 'hf/hub/models--o--n/refs/main' });
      expect(Buffer.from(client.sent[0].input.Body as Buffer).toString('utf8')).toBe('abc123');
    });
  });

  describe('uploadFile', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'model-store-test-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('uses a single PutObject below the part size', async () => {
      const file = join(dir, 'small.bin');
      await writeFile(file, Buffer.alloc(10, 1));
      const client = fakeClient(() => ({}));

      await new S3ModelStore(client, 'hope-models', { partSizeBytes: 64 }).uploadFile('k/small.bin', file);

      expect(client.sent.map((s) => s.name)).toEqual([PutObjectCommand.name]);
      expect(client.sent[0].input).toMatchObject({ Bucket: 'hope-models', Key: 'k/small.bin', ContentLength: 10 });
    });

    it('multipart-uploads from disk at or above the part size and completes with every ETag in order', async () => {
      const file = join(dir, 'big.bin');
      await writeFile(file, Buffer.alloc(150, 2));
      const client = fakeClient((cmd, name) => {
        if (name === CreateMultipartUploadCommand.name) return { UploadId: 'up-1' };
        if (name === UploadPartCommand.name) return { ETag: `"e${cmd.input.PartNumber}"` };
        return {};
      });

      await new S3ModelStore(client, 'hope-models', { partSizeBytes: 64 }).uploadFile('k/big.bin', file);

      const parts = client.sent.filter((s) => s.name === UploadPartCommand.name);
      expect(parts.map((p) => [p.input.PartNumber, p.input.ContentLength])).toEqual([
        [1, 64],
        [2, 64],
        [3, 22],
      ]);
      expect(parts.every((p) => p.input.UploadId === 'up-1')).toBe(true);
      const complete = client.sent.find((s) => s.name === CompleteMultipartUploadCommand.name)!;
      expect(complete.input.MultipartUpload).toEqual({
        Parts: [
          { PartNumber: 1, ETag: '"e1"' },
          { PartNumber: 2, ETag: '"e2"' },
          { PartNumber: 3, ETag: '"e3"' },
        ],
      });
    });

    it('aborts the multipart upload when a part fails, and rethrows', async () => {
      const file = join(dir, 'big.bin');
      await writeFile(file, Buffer.alloc(150, 2));
      const client = fakeClient((cmd, name) => {
        if (name === CreateMultipartUploadCommand.name) return { UploadId: 'up-2' };
        if (name === UploadPartCommand.name && cmd.input.PartNumber === 2) throw new Error('part 2 failed');
        if (name === UploadPartCommand.name) return { ETag: '"e"' };
        return {};
      });

      await expect(new S3ModelStore(client, 'hope-models', { partSizeBytes: 64 }).uploadFile('k/big.bin', file)).rejects.toThrow('part 2 failed');

      const abort = client.sent.find((s) => s.name === AbortMultipartUploadCommand.name);
      expect(abort?.input).toMatchObject({ Bucket: 'hope-models', Key: 'k/big.bin', UploadId: 'up-2' });
      expect(client.sent.some((s) => s.name === CompleteMultipartUploadCommand.name)).toBe(false);
    });
  });
});

describe('ModelStoreFactory (P8)', () => {
  const PLATFORM_KEYS = new Set(['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']);

  function appSettings(values: Record<string, unknown>) {
    return { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in values ? values[key] : fallback)) };
  }

  // TASK-1019 C3 — the key pair is delivered to the publisher pod ALONE as two
  // env vars (secretKeyRef); it is never a Vault kv read (under
  // SECRETS_PROVIDER=vault, SecretsService has no env fallback by design).
  function build(envValues: Record<string, string | undefined>, settings: Record<string, unknown> = {}) {
    const storageConfigRepository = { findAllTenantDefaults: vi.fn(async () => []) };
    const createClient = vi.fn((_config: Record<string, unknown>) => ({ send: vi.fn() }));
    const factory = new ModelStoreFactory(
      storageConfigRepository as never,
      appSettings({ S3_ENDPOINT: 'http://minio.local:9000', S3_REGION: 'eu-west-1', ...settings }) as never,
      envValues,
      createClient,
    );
    return { factory, createClient };
  }

  it('fails closed with MODEL_STORE_CREDENTIAL_MISSING and never builds a client from the platform storage keys', async () => {
    const env: Record<string, string | undefined> = {
      S3_ACCESS_KEY: 'platform-rw',
      S3_SECRET_KEY: 'platform-rw-secret',
      MINIO_ACCESS_KEY: 'minio',
      MINIO_SECRET_KEY: 'minio-secret',
    };
    const read: string[] = [];
    const { factory, createClient } = build(
      new Proxy(env, {
        get(target, prop: string) {
          read.push(prop);
          return target[prop];
        },
      }),
    );

    const failure = await factory.create().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ModelPublisherError);
    expect((failure as ModelPublisherError).code).toBe(MODEL_STORE_CREDENTIAL_MISSING);
    expect(createClient).not.toHaveBeenCalled();
    expect(read.some((key) => PLATFORM_KEYS.has(key))).toBe(false);
  });

  it('reads the key pair from the env (the publisher pod’s own secretKeyRef pair) — no SecretsService / Vault read', async () => {
    const { factory, createClient } = build({ MODEL_STORE_PUBLISHER_ACCESS_KEY_ID: ' pub ', MODEL_STORE_PUBLISHER_SECRET_KEY: 'pub-secret\n' });

    await factory.create();

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ credentials: { accessKeyId: 'pub', secretAccessKey: 'pub-secret' } }));
  });

  it('fails closed when only one half of the publisher key pair is set', async () => {
    const { factory, createClient } = build({ MODEL_STORE_PUBLISHER_ACCESS_KEY_ID: 'pub' });

    await expect(factory.create()).rejects.toMatchObject({ code: MODEL_STORE_CREDENTIAL_MISSING });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('builds the client from the publisher key pair and the platform storage endpoint/region', async () => {
    const { factory, createClient } = build({
      MODEL_STORE_PUBLISHER_ACCESS_KEY_ID: 'pub',
      MODEL_STORE_PUBLISHER_SECRET_KEY: 'pub-secret',
      S3_ACCESS_KEY: 'platform-rw',
    });

    const store = await factory.create();

    expect(store).toBeInstanceOf(S3ModelStore);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://minio.local:9000',
        region: 'eu-west-1',
        credentials: { accessKeyId: 'pub', secretAccessKey: 'pub-secret' },
      }),
    );
  });

  describe('per-request timeout (I7) — a half-open S3 socket fails the request instead of hanging the job', () => {
    const PAIR = { MODEL_STORE_PUBLISHER_ACCESS_KEY_ID: 'pub', MODEL_STORE_PUBLISHER_SECRET_KEY: 'pub-secret' };

    async function handlerConfig(createClient: ReturnType<typeof build>['createClient']) {
      const handler = createClient.mock.calls[0][0].requestHandler;
      expect(handler).toBeInstanceOf(NodeHttpHandler);
      // The handler resolves its options lazily; read what it will apply.
      return (await (handler as unknown as { configProvider: Promise<Record<string, unknown>> }).configProvider) as Record<string, unknown>;
    }

    it('defaults to modelRegistry.download.requestTimeoutSeconds = 600 s, and THROWS on breach (not a warning)', async () => {
      const { factory, createClient } = build(PAIR);
      await factory.create();
      expect(await handlerConfig(createClient)).toMatchObject({ requestTimeout: 600_000, throwOnRequestTimeout: true });
    });

    it('reads the configured timeout', async () => {
      const { factory, createClient } = build(PAIR, { 'modelRegistry.download.requestTimeoutSeconds': 30 });
      await factory.create();
      expect(await handlerConfig(createClient)).toMatchObject({ requestTimeout: 30_000 });
    });

    it('keeps the MINIO_CERT_CHECK relaxation on the same handler', async () => {
      const { factory, createClient } = build({ ...PAIR, MINIO_CERT_CHECK: 'false' });
      await factory.create();
      const config = await handlerConfig(createClient);
      expect(config.requestTimeout).toBe(600_000);
      expect((config.httpsAgent as { options?: { rejectUnauthorized?: boolean } }).options?.rejectUnauthorized).toBe(false);
    });
  });
});
