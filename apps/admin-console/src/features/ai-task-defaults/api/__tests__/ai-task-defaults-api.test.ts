/**
 * Ai-task-defaults client: gateway paths, the tenantId
 * scope passthrough (SYSTEM for the platform screen), and the If-Match OCC
 * PUT (expectedVersion from the read ETag; `"0"` creates the row).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveTaskDefault, getEffectiveTaskDefaults, getTaskDefaultRow, getTaskModelOptions, putTaskDefaultRow } from '../client';
import { aiTaskDefaultKeys } from '../keys';
import { SYSTEM_TENANT_ID } from '../types';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response): RecordedCall[] {
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

describe('task keys', () => {
  // The backend-mirror invariant itself is asserted in
  // `ai-task-keys-lockstep.test.ts`, which PARSES `AI_TASK_KEYS` out of
  // packages/applications/src/services/ai-task-default/constants.ts. This block
  // used to re-declare the expected 15 keys as a literal — which made it a
  // third copy of the same list, drifting alongside the mirror it guarded
  // (`guardrail.pii` / `guardrail.pii.spans` were missing from
  // both). Only the constant that has no backend counterpart is checked here.
  it('pins the SYSTEM tenant id', () => {
    expect(SYSTEM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('aiTaskDefaultKeys', () => {
  it('is stable and distinguishes scope, row and options', () => {
    expect(aiTaskDefaultKeys.effective('nlp.ner', SYSTEM_TENANT_ID)).toEqual(aiTaskDefaultKeys.effective('nlp.ner', SYSTEM_TENANT_ID));
    expect(aiTaskDefaultKeys.effective('nlp.ner')).not.toEqual(aiTaskDefaultKeys.effective('nlp.ner', SYSTEM_TENANT_ID));
    expect(aiTaskDefaultKeys.row('nlp.ner')).not.toEqual(aiTaskDefaultKeys.effective('nlp.ner'));
    expect(aiTaskDefaultKeys.options('nlp.ner')).not.toEqual(aiTaskDefaultKeys.row('nlp.ner'));
    expect(aiTaskDefaultKeys.root[0]).toBe('ai-task-defaults');
  });
});

describe('ai-task-defaults client', () => {
  it('reads effective defaults, row and options with the documented paths and params', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await getEffectiveTaskDefaults();
    await getEffectiveTaskDefaults(SYSTEM_TENANT_ID);
    await getEffectiveTaskDefault('nlp.ner');
    await getTaskDefaultRow('nlp.ner');
    await getTaskDefaultRow('guardrail.validate', SYSTEM_TENANT_ID);
    await getTaskModelOptions('nlp.classification');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/ai-task-defaults',
      `GET /api/hope/admin/ai-task-defaults?tenantId=${SYSTEM_TENANT_ID}`,
      'GET /api/hope/admin/ai-task-defaults?taskKey=nlp.ner',
      'GET /api/hope/admin/ai-task-defaults/row?taskKey=nlp.ner',
      `GET /api/hope/admin/ai-task-defaults/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`,
      'GET /api/hope/admin/ai-task-defaults/options?taskKey=nlp.classification',
    ]);
  });

  it('PUTs the row with If-Match + expectedVersion derived from the read ETag', async () => {
    const calls = installFetchMock(() => Response.json({ version: 4 }, { headers: { etag: '"4"' } }));
    await putTaskDefaultRow('nlp.ner', { modelSlug: 'medical-ner' }, '"3"');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/hope/admin/ai-task-defaults/row?taskKey=nlp.ner');
    expect(calls[0].headers.get('if-match')).toBe('"3"');
    expect(calls[0].body).toEqual({ modelSlug: 'medical-ner', expectedVersion: 3 });
  });

  it('creates a missing row with the "0" precondition, scoped to SYSTEM for the platform screen', async () => {
    const calls = installFetchMock(() => Response.json({ version: 1 }, { headers: { etag: '"1"' } }));
    await putTaskDefaultRow('guardrail.validate', { modelSlug: 'granite-guardian-4.1-8b' }, null, SYSTEM_TENANT_ID);
    expect(calls[0].url).toBe(`/api/hope/admin/ai-task-defaults/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`);
    expect(calls[0].headers.get('if-match')).toBe('"0"');
    expect(calls[0].body).toEqual({ modelSlug: 'granite-guardian-4.1-8b', expectedVersion: 0 });
  });
});
