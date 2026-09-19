/**
 * Frame 33 — DNA writing styles API layer. fetch is stubbed at the network
 * boundary and every call is asserted as an exact "METHOD /api/hope/<path>"
 * string against DnaWritingStyleAdminController. NOTE this controller's list
 * page param is ONE-based (`Number(page) || 1`), unlike the zero-based
 * PaginatedQuery convention used elsewhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateDnaReport,
  getDnaDashboard,
  getDnaJobStatus,
  getDoctorReport,
  listDnaReports,
  listDnaVersions,
  resetDoctorDnaProfile,
  updateDnaReport,
} from '../client';
import { dnaKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response = () => Response.json({})): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dnaKeys', () => {
  it('is stable for equal params and distinct across scopes', () => {
    expect(dnaKeys.list({ page: 1, limit: 25 })).toEqual(dnaKeys.list({ page: 1, limit: 25 }));
    expect(dnaKeys.list({ page: 1 })).not.toEqual(dnaKeys.list({ page: 2 }));
    expect(dnaKeys.doctor('doc-1')).not.toEqual(dnaKeys.doctor('doc-2'));
    expect(dnaKeys.versions('rep-1')).not.toEqual(dnaKeys.doctor('rep-1'));
    expect(dnaKeys.job('job-1')).not.toEqual(dnaKeys.job('job-2'));
  });

  it('roots every key under the domain namespace for coarse invalidation', () => {
    for (const key of [dnaKeys.list(), dnaKeys.dashboard(), dnaKeys.doctor('x'), dnaKeys.versions('x'), dnaKeys.job('x')]) {
      expect(key[0]).toBe('dna-writing-styles');
    }
  });
});

describe('dna writing styles client', () => {
  it('lists reports with the ONE-based page, doctorId and includeDisabled params', async () => {
    const calls = installFetchMock(() => Response.json({ data: [], count: 0, limit: 25, page: 1 }));
    await listDnaReports({ page: 1, limit: 25, doctorId: 'doc-1', includeDisabled: true });
    await listDnaReports();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/dna-writing-styles?page=1&limit=25&doctorId=doc-1&includeDisabled=true',
      'GET /api/hope/admin/dna-writing-styles',
    ]);
  });

  it('reads the dashboard roll-up', async () => {
    const calls = installFetchMock();
    await getDnaDashboard();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/dna-writing-styles/dashboard']);
  });

  it('reads a doctor latest report keeping the ETag for the later PATCH', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'rep-1', version: 3 }, { headers: { etag: '"3"' } }));
    const read = await getDoctorReport('doc-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/dna-writing-styles/doctor/doc-1']);
    expect(read.etag).toBe('"3"');
    expect(read.data.version).toBe(3);
  });

  it('updates a report with If-Match AND the body expectedVersion (OCC contract)', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'rep-1', version: 4 }, { headers: { etag: '"4"' } }));
    await updateDnaReport('rep-1', { styleText: 'Formal, concise.', changeReason: 'manual edit' }, '"3"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/dna-writing-styles/rep-1']);
    expect(calls[0].headers.get('if-match')).toBe('"3"');
    expect(calls[0].body).toEqual({ styleText: 'Formal, concise.', changeReason: 'manual edit', expectedVersion: 3 });
  });

  it('queues a generation job for a doctor (empty body allowed)', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'job-1', status: 'PENDING' }));
    const job = await generateDnaReport('doc-1');
    await generateDnaReport('doc-2', { editedSummary: 'Seed text' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/admin/dna-writing-styles/generate/doc-1',
      'POST /api/hope/admin/dna-writing-styles/generate/doc-2',
    ]);
    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ editedSummary: 'Seed text' });
    expect(job.jobId).toBe('job-1');
  });

  it('reads the version timeline of a report', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await listDnaVersions('rep-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/dna-writing-styles/rep-1/versions']);
  });

  it('reads a generation job status', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'job-1', status: 'processing', progress: 40 }));
    const status = await getDnaJobStatus('job-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/dna-writing-styles/jobs/job-1']);
    expect(status.status).toBe('processing');
  });

  it('escapes path params', async () => {
    const calls = installFetchMock();
    await getDoctorReport('doc/1');
    await listDnaVersions('rep 1');
    await getDnaJobStatus('job#1');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/admin/dna-writing-styles/doctor/doc%2F1',
      '/api/hope/admin/dna-writing-styles/rep%201/versions',
      '/api/hope/admin/dna-writing-styles/jobs/job%231',
    ]);
  });

  // F-9 — the admin half of INV-240's "deletable by the clinician" requirement.
  it('erases a doctor\'s whole DNA profile through DELETE doctor/:doctorId (no body, id escaped)', async () => {
    const calls = installFetchMock(() => Response.json({ doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 }));
    const result = await resetDoctorDnaProfile('doc-1');
    await resetDoctorDnaProfile('doc/1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/hope/admin/dna-writing-styles/doctor/doc-1',
      'DELETE /api/hope/admin/dna-writing-styles/doctor/doc%2F1',
    ]);
    expect(calls[0].body).toBeUndefined();
    expect(result).toEqual({ doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 });
  });
});
