/**
 * `ConsultationContextSchema` API module. Paths and envelopes verified
 * against `ConsultationContextSchemaAdminController`
 * (`admin/consultation-context-schemas`): OCC If-Match on `PATCH :id` only —
 * `publish` and `pin` are plain POSTs the server validates itself.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createContextSchema,
  deleteContextSchema,
  getContextSchema,
  listContextSchemaVersions,
  listContextSchemas,
  listDepartments,
  pinContextSchemaVersion,
  publishContextSchema,
  updateContextSchema,
} from '../client';
import { contextSchemaKeys } from '../keys';
import type { ContextSchemaDefinition } from '../types';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
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
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return Response.json({ success: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contextSchemaKeys', () => {
  it('roots every key at ["context-schemas"] and separates lists, details and versions', () => {
    expect(contextSchemaKeys.list()).toEqual(contextSchemaKeys.list());
    expect(contextSchemaKeys.detail('s-1')).not.toEqual(contextSchemaKeys.versions('s-1'));
    expect(contextSchemaKeys.detail('s-1')[0]).toBe('context-schemas');
    expect(contextSchemaKeys.departments()[0]).toBe('context-schemas');
  });
});

describe('context-schemas client', () => {
  it('lists (no params), creates, reads and soft-deletes schemas', async () => {
    const calls = installFetchMock();
    await listContextSchemas();
    await createContextSchema({ slug: 'general_medicine', name: 'General Medicine Context' });
    await getContextSchema('s-1');
    await deleteContextSchema('s-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/consultation-context-schemas',
      'POST /api/hope/admin/consultation-context-schemas',
      'GET /api/hope/admin/consultation-context-schemas/s-1',
      'DELETE /api/hope/admin/consultation-context-schemas/s-1',
    ]);
    expect(calls[1].body).toEqual({ slug: 'general_medicine', name: 'General Medicine Context' });
  });

  it('PATCHes metadata with If-Match and the ETag-derived expectedVersion', async () => {
    const calls = installFetchMock();
    await updateContextSchema('s-1', { name: 'Renamed', isDefault: true }, '"3"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/consultation-context-schemas/s-1']);
    expect(calls[0].headers['if-match']).toBe('"3"');
    expect(calls[0].body).toEqual({ name: 'Renamed', isDefault: true, expectedVersion: 3 });
  });

  it('publishes a definition WITHOUT an If-Match header', async () => {
    const calls = installFetchMock();
    const definition: ContextSchemaDefinition = {
      schemaVersion: '1.0',
      kinds: [{ key: 'note', label: 'Note', primitive: 'TEXT', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'ANY', producedBy: ['CLIENT'] }],
    };
    await publishContextSchema('s-1', { definition, changeReason: 'initial publish' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/consultation-context-schemas/s-1/publish']);
    expect(calls[0].headers['if-match']).toBeUndefined();
    expect(calls[0].body).toEqual({ definition, changeReason: 'initial publish' });
  });

  it('pins a version WITHOUT an If-Match header', async () => {
    const calls = installFetchMock();
    await pinContextSchemaVersion('s-1', 2);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/consultation-context-schemas/s-1/pin']);
    expect(calls[0].headers['if-match']).toBeUndefined();
    expect(calls[0].body).toEqual({ versionNumber: 2 });
  });

  it('lists immutable versions', async () => {
    const calls = installFetchMock();
    await listContextSchemaVersions('s-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/consultation-context-schemas/s-1/versions']);
  });

  it('reads the department directory for the scope/department pickers', async () => {
    const calls = installFetchMock();
    await listDepartments();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/departments']);
  });
});
