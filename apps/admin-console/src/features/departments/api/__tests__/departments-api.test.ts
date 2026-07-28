import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDepartment,
  deleteDepartment,
  getDepartment,
  getDepartmentByCode,
  listDepartmentChildren,
  listDepartmentUsers,
  listDepartments,
  listPromptTemplateOptions,
  listRootDepartments,
  updateDepartment,
  updateDepartmentPromptConfig,
} from '../client';
import { departmentKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response = () => Response.json({ id: 'dep-1', version: 1 })): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
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

describe('departmentKeys', () => {
  it('is stable for equal inputs and distinct across scopes', () => {
    expect(departmentKeys.list()).toEqual(departmentKeys.list());
    expect(departmentKeys.users('dep-1', { page: 0 })).toEqual(departmentKeys.users('dep-1', { page: 0 }));
    expect(departmentKeys.detail('dep-1')).not.toEqual(departmentKeys.detail('dep-2'));
    expect(departmentKeys.children('dep-1')).not.toEqual(departmentKeys.roots());
    expect(departmentKeys.users('dep-1')).not.toEqual(departmentKeys.children('dep-1'));
  });

  it('roots every key under the domain namespace for coarse invalidation', () => {
    const keys = [departmentKeys.list(), departmentKeys.roots(), departmentKeys.detail('x'), departmentKeys.children('x'), departmentKeys.users('x')];
    for (const key of keys) {
      expect(key[0]).toBe('departments');
    }
  });
});

describe('departments client', () => {
  it('reads the flat list, roots and children as plain arrays on the documented paths', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await listDepartments();
    await listDepartments({ includeDisabled: true });
    await listRootDepartments();
    await listDepartmentChildren('dep-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/departments',
      'GET /api/hope/admin/departments?includeDisabled=true',
      'GET /api/hope/admin/departments/roots',
      'GET /api/hope/admin/departments/dep-1/children',
    ]);
  });

  it('captures the ETag on the detail and code reads for the later PATCH', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'dep-1', name: 'Cardiology', version: 7 }, { headers: { etag: '"7"' } }));
    const read = await getDepartment('dep-1');
    const byCode = await getDepartmentByCode('CARD');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/departments/dep-1',
      'GET /api/hope/admin/departments/code/CARD',
    ]);
    expect(read.etag).toBe('"7"');
    expect(read.data.version).toBe(7);
    expect(byCode.etag).toBe('"7"');
  });

  it('lists department members through the paginated :id/users route', async () => {
    const calls = installFetchMock(() => Response.json({ data: [], count: 0, limit: 25, page: 0 }));
    await listDepartmentUsers('dep-1', { page: 0, limit: 25 });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/departments/dep-1/users?page=0&limit=25']);
  });

  it('creates a department with a POST on the collection path', async () => {
    const calls = installFetchMock();
    await createDepartment({ name: 'Cardiology', code: 'CARD', parentDepartmentId: 'dep-root' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/departments']);
    expect(calls[0].body).toEqual({ name: 'Cardiology', code: 'CARD', parentDepartmentId: 'dep-root' });
  });

  it('updates a department with If-Match AND the body expectedVersion (OCC contract)', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'dep-1', version: 8 }, { headers: { etag: '"8"' } }));
    await updateDepartment('dep-1', { name: 'Cardiology & Vascular' }, '"7"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/departments/dep-1']);
    expect(calls[0].headers.get('if-match')).toBe('"7"');
    expect(calls[0].body).toEqual({ name: 'Cardiology & Vascular', expectedVersion: 7 });
  });

  it('updates the prompt config on its own OCC PATCH route', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'dep-1', version: 4 }, { headers: { etag: '"4"' } }));
    await updateDepartmentPromptConfig('dep-1', { preSummaryPromptId: 'pt-1', dnaWritingStylePromptId: 'pt-9' }, '"3"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/departments/dep-1/prompt-config']);
    expect(calls[0].headers.get('if-match')).toBe('"3"');
    expect(calls[0].body).toEqual({ preSummaryPromptId: 'pt-1', dnaWritingStylePromptId: 'pt-9', expectedVersion: 3 });
  });

  it('reads the prompt-template Select catalog and projects id+name from the paginated envelope', async () => {
    const calls = installFetchMock(() =>
      Response.json({
        data: [{ id: 'pt-1', name: 'Cardiology Notes', category: 'SUMMARY', status: 'PUBLISHED' }],
        count: 1,
        limit: 100,
        page: 1,
      }),
    );
    const options = await listPromptTemplateOptions();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/prompt-templates?page=1&limit=100']);
    expect(options).toEqual([{ id: 'pt-1', name: 'Cardiology Notes' }]);
  });

  it('soft-deletes a department with a DELETE on the id path', async () => {
    const calls = installFetchMock();
    await deleteDepartment('dep-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/hope/admin/departments/dep-1']);
  });
});
