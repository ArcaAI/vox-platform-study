/**
 * TASK-984 — presigned URLs are SIGNED for the public origin, not rewritten.
 *
 * Deliberately NOT mocking the AWS SDK: the defect is about what the real
 * signer puts in the URL. Presigning is offline, so no network is touched.
 *
 * `verifySigV4Query` is an independent re-implementation of the AWS SigV4
 * query-string check an S3 server (MinIO) performs: it recomputes the
 * signature from the URL's own host and path. A URL signed for
 * `hope-minio:9000` and edited to say `admin.example.com` fails it; a URL
 * signed for `admin.example.com` passes.
 */

import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageProvider } from '@arcaai/types';
import { S3BlobProvider, type S3BlobProviderConfig } from '../s3-blob.provider';

const SECRET = 'test-secret';

function makeProvider(overrides: Partial<S3BlobProviderConfig> = {}): S3BlobProvider {
  return new S3BlobProvider({
    endpoint: 'https://hope-minio:9000',
    region: 'us-east-1',
    accessKeyId: 'test-access',
    secretAccessKey: SECRET,
    forcePathStyle: true,
    provider: StorageProvider.MINIO,
    ...overrides,
  });
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** Recompute the SigV4 presigned-query signature for the URL as a server receives it. */
function verifySigV4Query(rawUrl: string, secretAccessKey: string): boolean {
  const url = new URL(rawUrl);
  const pairs = url.search.slice(1).split('&');
  const signature = pairs.find((pair) => pair.startsWith('X-Amz-Signature='))?.split('=')[1];
  const get = (name: string) => decodeURIComponent(pairs.find((pair) => pair.startsWith(`${name}=`))?.split('=')[1] ?? '');

  const canonicalQuery = pairs
    .filter((pair) => !pair.startsWith('X-Amz-Signature='))
    .sort((a, b) => (a.split('=')[0] < b.split('=')[0] ? -1 : 1))
    .join('&');
  const canonicalRequest = ['GET', url.pathname, canonicalQuery, `host:${url.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');

  const amzDate = get('X-Amz-Date');
  const [, date, region, service] = get('X-Amz-Credential').split('/');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex') === signature;
}

describe('S3BlobProvider presigning origin (TASK-984)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs a GET for the public origin when one is configured', async () => {
    const provider = makeProvider({ publicEndpoint: 'https://admin.example.com' });

    const url = new URL(await provider.presignGet({ bucket: 'hope-audio', key: '2026/09/a.wav', expiresInSeconds: 3600 }));

    expect(url.origin).toBe('https://admin.example.com');
    expect(url.pathname).toBe('/hope-audio/2026/09/a.wav');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(verifySigV4Query(url.toString(), SECRET)).toBe(true);
  });

  it('a URL signed for the internal host does NOT verify once its host is rewritten', async () => {
    const internal = await makeProvider().presignGet({ bucket: 'hope-audio', key: 'a.wav', expiresInSeconds: 3600 });
    const rewritten = internal.replace('https://hope-minio:9000', 'https://admin.example.com');

    expect(verifySigV4Query(internal, SECRET)).toBe(true);
    expect(verifySigV4Query(rewritten, SECRET)).toBe(false);
  });

  it('keeps signing with the endpoint when no public origin is configured', async () => {
    const url = new URL(await makeProvider().presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 60 }));

    expect(url.origin).toBe('https://hope-minio:9000');
  });

  it('keeps a port on the public origin', async () => {
    const provider = makeProvider({ endpoint: 'http://localhost:9000', publicEndpoint: 'http://127.0.0.1:9000' });

    const url = new URL(await provider.presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 60 }));

    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(verifySigV4Query(url.toString(), SECRET)).toBe(true);
  });

  it('asks the store to mark the download private, no-store so a CDN on the public origin never caches it', async () => {
    const url = new URL(await makeProvider({ publicEndpoint: 'https://admin.example.com' }).presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 60 }));

    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
  });

  it('signs a PUT for the public origin too', async () => {
    const provider = makeProvider({ publicEndpoint: 'https://admin.example.com' });

    const url = new URL(await provider.presignPut({ bucket: 'b', key: 'k', expiresInSeconds: 60, contentType: 'text/plain' }));

    expect(url.origin).toBe('https://admin.example.com');
  });
});
