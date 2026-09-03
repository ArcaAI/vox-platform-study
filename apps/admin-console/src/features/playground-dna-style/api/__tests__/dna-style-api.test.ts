/**
 * Frame 53 — playground DNA writing-style API layer (SELF plane). fetch is
 * stubbed at the network boundary and every call is asserted as an exact
 * "METHOD /api/hope/<path>" string against DnaWritingStyleController
 * (`@Controller('dna-writing-styles')` — NO admin/ prefix). OCC contract:
 * PATCH :reportId requires If-Match (428/412); PUT settings carries If-Match
 * only once a DOCTOR-scope row exists (`version >= 1`, 0 = no row yet).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dnaJobStreamPath,
  eraseMyReport,
  eraseMyStyle,
  generateMyStyle,
  getDnaJobStatus,
  getDnaSettings,
  getMyStyle,
  listMyReports,
  listMyVersions,
  setDefaultReport,
  updateDnaSettings,
  updateMyReport,
} from '../client';
import { playgroundDnaKeys } from '../keys';

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

describe('playgroundDnaKeys', () => {
  it('is stable for equal args and distinct across scopes', () => {
    expect(playgroundDnaKeys.myStyle()).toEqual(playgroundDnaKeys.myStyle());
    expect(playgroundDnaKeys.versions('rep-1')).not.toEqual(playgroundDnaKeys.versions('rep-2'));
    expect(playgroundDnaKeys.versions('x')).not.toEqual(playgroundDnaKeys.job('x'));
    expect(playgroundDnaKeys.reports()).not.toEqual(playgroundDnaKeys.settings());
  });

  it('roots every key under the feature namespace for coarse invalidation', () => {
    for (const key of [
      playgroundDnaKeys.myStyle(),
      playgroundDnaKeys.reports(),
      playgroundDnaKeys.versions('x'),
      playgroundDnaKeys.settings(),
      playgroundDnaKeys.job('x'),
    ]) {
      expect(key[0]).toBe('playground-dna-style');
    }
  });
});

describe('playground dna style client', () => {
  it('reads my-style keeping the ETag for the later PATCH', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'rep-1', version: 3 }, { headers: { etag: '"3"' } }));
    const read = await getMyStyle();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/dna-writing-styles/my-style']);
    expect(read.etag).toBe('"3"');
    expect(read.data.version).toBe(3);
  });

  it('lists my reports (owner-scoped, no params)', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await listMyReports();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/dna-writing-styles/mine']);
  });

  it('updates a report with If-Match AND the body expectedVersion (OCC contract)', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'rep-1', version: 4 }, { headers: { etag: '"4"' } }));
    await updateMyReport('rep-1', { styleText: 'Concise clinical prose.', changeReason: 'tone fix' }, '"3"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/dna-writing-styles/rep-1']);
    expect(calls[0].headers.get('if-match')).toBe('"3"');
    expect(calls[0].body).toEqual({ styleText: 'Concise clinical prose.', changeReason: 'tone fix', expectedVersion: 3 });
  });

  // phase 2: `PATCH :reportId/default` now requires `If-Match`.
  // The validator is the report row's `version` from the list read — the
  // console echoes it rather than inventing one.
  it('promotes a report to default under If-Match', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'rep-2', isLatest: true, version: 7 }));
    await setDefaultReport('rep-2', '"6"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/dna-writing-styles/rep-2/default']);
    expect(calls[0].headers.get('if-match')).toBe('"6"');
    expect(calls[0].body).toEqual({});
  });

  it('erases the whole learned profile through DELETE my-style (no body)', async () => {
    const calls = installFetchMock(() => Response.json({ doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 }));
    const result = await eraseMyStyle();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/hope/dna-writing-styles/my-style']);
    expect(calls[0].body).toBeUndefined();
    expect(result).toEqual({ doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 });
  });

  it('erases ONE owned report through DELETE :reportId (escaping the id)', async () => {
    const calls = installFetchMock(() => Response.json({ doctorId: 'doc-1', deletedReports: 1, deletedVersions: 3 }));
    const result = await eraseMyReport('rep-1');
    await eraseMyReport('rep/1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/hope/dna-writing-styles/rep-1',
      'DELETE /api/hope/dna-writing-styles/rep%2F1',
    ]);
    expect(result.deletedReports).toBe(1);
  });

  it('reads the version timeline of a report', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await listMyVersions('rep-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/dna-writing-styles/rep-1/versions']);
  });

  it('queues a self-generation job (empty body allowed, samples passed through)', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'job-1', status: 'PENDING' }));
    const job = await generateMyStyle();
    await generateMyStyle({ textSamples: ['Sample one.', 'Sample two.'] });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/dna-writing-styles/generate',
      'POST /api/hope/dna-writing-styles/generate',
    ]);
    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ textSamples: ['Sample one.', 'Sample two.'] });
    expect(job.jobId).toBe('job-1');
  });

  it('reads the per-doctor DNA settings', async () => {
    const calls = installFetchMock(() => Response.json({ doctorToggle: null, tenantEnabled: true, effective: true, version: 0 }));
    const settings = await getDnaSettings();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/dna-writing-styles/settings']);
    expect(settings.effective).toBe(true);
  });

  it('writes the DNA toggle with If-Match + expectedVersion once a row exists (version >= 1)', async () => {
    const calls = installFetchMock(() => Response.json({ doctorToggle: false, tenantEnabled: true, effective: false, version: 3 }));
    await updateDnaSettings({ enabled: false }, 2);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PUT /api/hope/dna-writing-styles/settings']);
    expect(calls[0].headers.get('if-match')).toBe('"2"');
    expect(calls[0].body).toEqual({ enabled: false, expectedVersion: 2 });
  });

  // phase 2: `PUT settings` now requires `If-Match`, so the FIRST
  // write carries the gateway's create-intent validator `"0"` — the value
  // `GET settings` actually returned — instead of omitting the header. The body
  // field is still withheld, because its validator rejects 0.
  it('writes the first toggle with the create-intent If-Match "0" when no DOCTOR row exists yet', async () => {
    const calls = installFetchMock(() => Response.json({ doctorToggle: true, tenantEnabled: true, effective: true, version: 1 }));
    await updateDnaSettings({ enabled: true }, 0);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PUT /api/hope/dna-writing-styles/settings']);
    expect(calls[0].headers.get('if-match')).toBe('"0"');
    expect(calls[0].body).toEqual({ enabled: true });
  });

  it('reads a generation job status and builds the gateway-relative stream path', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'job-1', status: 'processing', progress: 40 }));
    const status = await getDnaJobStatus('job-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/dna-writing-styles/jobs/job-1']);
    expect(status.status).toBe('processing');
    expect(dnaJobStreamPath('job-1')).toBe('dna-writing-styles/jobs/job-1/stream');
  });

  it('escapes path params', async () => {
    const calls = installFetchMock();
    await updateMyReport('rep/1', {}, '"1"');
    await listMyVersions('rep 1');
    await getDnaJobStatus('job#1');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/dna-writing-styles/rep%2F1',
      '/api/hope/dna-writing-styles/rep%201/versions',
      '/api/hope/dna-writing-styles/jobs/job%231',
    ]);
    expect(dnaJobStreamPath('job#1')).toBe('dna-writing-styles/jobs/job%231/stream');
  });
});
