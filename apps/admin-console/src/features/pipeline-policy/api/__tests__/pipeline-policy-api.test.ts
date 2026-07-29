/**
 * TDD client tests for the realtime pipeline policy API module (frame 39):
 * the effective-cascade GET (query context), the editable row GET keeping the
 * ETag, and the PUT row upsert — If-Match from the read on an existing row,
 * placeholder validator "1" when creating a row that does not exist yet
 * (version 0 emits no ETag but @RequiresIfMatch still demands the header).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPipelinePolicyEffective, getPipelinePolicyRow, getSystemPipelinePolicyRow, putPipelinePolicyRow } from '../client';
import { pipelinePolicyKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response = () => Response.json({ ok: true })): RecordedCall[] {
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

describe('pipelinePolicyKeys', () => {
  it('is stable and separates the effective cascade from scope rows', () => {
    expect(pipelinePolicyKeys.effective({})).toEqual(pipelinePolicyKeys.effective({}));
    expect(pipelinePolicyKeys.effective({ departmentId: 'd-1' })).not.toEqual(pipelinePolicyKeys.effective({}));
    expect(pipelinePolicyKeys.row('TENANT', null)).not.toEqual(pipelinePolicyKeys.row('DEPARTMENT', 'd-1'));
    expect(pipelinePolicyKeys.row('TENANT', null)[0]).toBe('pipeline-policy');
    expect(pipelinePolicyKeys.systemRow()).not.toEqual(pipelinePolicyKeys.row('TENANT', null));
  });
});

describe('pipeline policy client', () => {
  it('reads the effective cascade, forwarding the department/doctor context', async () => {
    const calls = installFetchMock();
    await getPipelinePolicyEffective({});
    await getPipelinePolicyEffective({ departmentId: 'd-1', doctorId: 'u-9' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/harness/pipeline-policy',
      'GET /api/hope/admin/harness/pipeline-policy?departmentId=d-1&doctorId=u-9',
    ]);
  });

  it('reads one editable scope row keeping the ETag (TENANT omits scopeId)', async () => {
    const calls = installFetchMock(() => Response.json({ version: 2 }, { headers: { etag: '"2"' } }));
    const tenantRow = await getPipelinePolicyRow('TENANT', null);
    await getPipelinePolicyRow('DEPARTMENT', 'd-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/harness/pipeline-policy/row?scope=TENANT',
      'GET /api/hope/admin/harness/pipeline-policy/row?scope=DEPARTMENT&scopeId=d-1',
    ]);
    expect(tenantRow.etag).toBe('"2"');
  });

  it('reads the SYSTEM-tenant platform default row via ?tenantId= (elevated sessions only)', async () => {
    const calls = installFetchMock();
    await getSystemPipelinePolicyRow();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/harness/pipeline-policy/row?tenantId=00000000-0000-0000-0000-000000000000&scope=TENANT',
    ]);
  });

  it('PUTs an existing row with If-Match and expectedVersion from the read ETag', async () => {
    const calls = installFetchMock();
    await putPipelinePolicyRow('DEPARTMENT', 'd-1', { autoSummaryEnabled: false, reason: 'ward pilot' }, '"4"');
    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('PUT /api/hope/admin/harness/pipeline-policy/row?scope=DEPARTMENT&scopeId=d-1');
    expect(calls[0].headers.get('if-match')).toBe('"4"');
    expect(calls[0].body).toEqual({ autoSummaryEnabled: false, reason: 'ward pilot', expectedVersion: 4 });
  });

  it('PUTs a NEW row (no ETag yet) with the placeholder validator "1" and no expectedVersion', async () => {
    const calls = installFetchMock();
    await putPipelinePolicyRow('DOCTOR', 'u-9', { autoNerEnabled: true }, null);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('PUT /api/hope/admin/harness/pipeline-policy/row?scope=DOCTOR&scopeId=u-9');
    expect(calls[0].headers.get('if-match')).toBe('"1"');
    expect(calls[0].body).toEqual({ autoNerEnabled: true });
  });

  it('supports null toggle values in the PUT body (clear the pin = inherit)', async () => {
    const calls = installFetchMock();
    await putPipelinePolicyRow('TENANT', null, { harnessEnabled: null }, '"2"');
    expect(`${calls[0].method} ${calls[0].url}`).toBe('PUT /api/hope/admin/harness/pipeline-policy/row?scope=TENANT');
    expect(calls[0].body).toEqual({ harnessEnabled: null, expectedVersion: 2 });
  });
});
