/**
 * TASK-999 C-2 — the `jobType` list filter added to `GET
 * /admin/audio/transcription-jobs`. New file (does not touch the existing
 * `transcription-jobs-api.test.ts`, which predates this filter). RED before
 * this change: `listTranscriptionJobs` had no `jobType` param on its type or
 * in its call site, so passing one was a compile error and the base case's
 * query string never included the new param either way.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { listTranscriptionJobs } from '../client';

interface RecordedCall {
  url: string;
  method: string;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ data: [], total: 0, page: 1, limit: 25, totalPages: 0 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listTranscriptionJobs — jobType filter', () => {
  it('sends jobType as a query param when narrowing to one kind', async () => {
    const calls = installFetchMock();
    await listTranscriptionJobs({ page: 1, limit: 25, jobType: 'STREAMING' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/audio/transcription-jobs?page=1&limit=25&jobType=STREAMING',
    ]);
  });

  it('sends the other kind unchanged', async () => {
    const calls = installFetchMock();
    await listTranscriptionJobs({ page: 1, limit: 25, jobType: 'BATCH' });
    expect(calls[0].url).toBe('/api/hope/admin/audio/transcription-jobs?page=1&limit=25&jobType=BATCH');
  });

  it('sends no jobType param when it is omitted ("All")', async () => {
    const calls = installFetchMock();
    await listTranscriptionJobs({ page: 1, limit: 25 });
    expect(calls[0].url).toBe('/api/hope/admin/audio/transcription-jobs?page=1&limit=25');
  });
});
