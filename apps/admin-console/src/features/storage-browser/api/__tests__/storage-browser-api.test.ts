import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBucket,
  deleteBucket,
  deleteFile,
  getBucket,
  getFileInfo,
  getStorageHealth,
  listBuckets,
  listBucketsAllTenants,
  listObjects,
  updateBucket,
  uploadFile,
} from '../client';
import { storageBrowserKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  /** Raw body as handed to fetch — kept for FormData assertions. */
  rawBody: BodyInit | null | undefined;
  contentType: string | null;
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
        contentType: new Headers(init?.headers).get('content-type'),
      });
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storageBrowserKeys', () => {
  it('is stable and separates buckets, objects and health', () => {
    expect(storageBrowserKeys.buckets()).toEqual(storageBrowserKeys.buckets());
    expect(storageBrowserKeys.objects('consult-audio', 'recordings/')).toEqual(storageBrowserKeys.objects('consult-audio', 'recordings/'));
    expect(storageBrowserKeys.objects('consult-audio')).not.toEqual(storageBrowserKeys.objects('doc-attachments'));
    expect(storageBrowserKeys.objects('consult-audio', 'a/')).not.toEqual(storageBrowserKeys.objects('consult-audio', 'b/'));
    expect(storageBrowserKeys.bucket('consult-audio')).not.toEqual(storageBrowserKeys.buckets());
    expect(storageBrowserKeys.health()[0]).toBe('storage-browser');
    expect(storageBrowserKeys.bucketsAllTenants()).not.toEqual(storageBrowserKeys.buckets());
  });
});

describe('storage-browser client', () => {
  it('covers the bucket lifecycle: list, create, read, update, delete', async () => {
    const calls = installFetchMock();
    await listBuckets();
    await createBucket({ name: 'exports' });
    await getBucket('consult-audio');
    await updateBucket('consult-audio', { description: 'Consultation audio' });
    await deleteBucket('consult-audio');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/storage/buckets',
      'POST /api/hope/storage/buckets',
      'GET /api/hope/storage/buckets/consult-audio',
      'PATCH /api/hope/storage/buckets/consult-audio',
      'DELETE /api/hope/storage/buckets/consult-audio',
    ]);
    expect(calls[1].body).toEqual({ name: 'exports' });
    expect(calls[3].body).toEqual({ description: 'Consultation audio' });
  });

  it('lists the "All tenants" listing with includePhysical=true', async () => {
    const calls = installFetchMock();
    await listBucketsAllTenants();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/storage/buckets?includePhysical=true']);
  });

  it('lists objects with an optional prefix filter', async () => {
    const calls = installFetchMock();
    await listObjects('consult-audio');
    await listObjects('consult-audio', 'recordings/2026-07/');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/storage/buckets/consult-audio/files',
      'GET /api/hope/storage/buckets/consult-audio/files?prefix=recordings%2F2026-07%2F',
    ]);
  });

  it('presigns downloads and deletes objects, encoding the key as ONE path segment', async () => {
    const calls = installFetchMock();
    await getFileInfo('consult-audio', 'c_9f2ka7_0703.wav');
    await deleteFile('consult-audio', 'c_9f2ka7_0703.wav');
    // Keys can contain slashes in listings (other producers write nested
    // keys); the gateway declares a single :key segment, so the whole key
    // is percent-encoded rather than left as extra path segments.
    await getFileInfo('consult-audio', 'recordings/2026-07/c_9f2ka7_0703.wav');
    await deleteFile('consult-audio', 'exports/summary june.pdf');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/storage/buckets/consult-audio/files/c_9f2ka7_0703.wav',
      'DELETE /api/hope/storage/buckets/consult-audio/files/c_9f2ka7_0703.wav',
      'GET /api/hope/storage/buckets/consult-audio/files/recordings%2F2026-07%2Fc_9f2ka7_0703.wav',
      'DELETE /api/hope/storage/buckets/consult-audio/files/exports%2Fsummary%20june.pdf',
    ]);
  });

  it('uploads multipart FormData under the "file" field with the key as a query param', async () => {
    const calls = installFetchMock();
    const file = new File(['clinical note'], 'note.txt', { type: 'text/plain' });
    await uploadFile('consult-audio', file, 'note.txt');
    await uploadFile('consult-audio', file);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/storage/buckets/consult-audio/files?key=note.txt',
      'POST /api/hope/storage/buckets/consult-audio/files',
    ]);

    const form = calls[0].rawBody;
    expect(form).toBeInstanceOf(FormData);
    const part = (form as FormData).get('file');
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe('note.txt');
    // The browser must set the multipart boundary itself.
    expect(calls[0].contentType).toBeNull();
  });

  it('reads the storage health probe', async () => {
    const calls = installFetchMock();
    await getStorageHealth();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/storage/health']);
  });
});
