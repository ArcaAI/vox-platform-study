import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignDepartment,
  assignRole,
  bulkUserAction,
  createUser,
  deleteUser,
  exportUsers,
  getUser,
  getUserProfile,
  impersonateUser,
  listUserApiKeys,
  listUserDepartments,
  listUserRoles,
  listUserSettings,
  listUsers,
  listVoiceProfiles,
  removeDepartment,
  removeRole,
  resetPassword,
  revokeImpersonation,
  setUserDepartments,
  updateDepartment,
  updateUser,
  updateUserProfile,
  updateUserSetting,
  updateUserStatus,
} from '../client';
import { userKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response?: () => Response): RecordedCall[] {
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
      return response ? response() : Response.json({ id: 'u-1' });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('userKeys', () => {
  it('is stable and scoped per user + sub-resource', () => {
    expect(userKeys.list({ page: 0 })).toEqual(userKeys.list({ page: 0 }));
    expect(userKeys.detail('u-1')).not.toEqual(userKeys.detail('u-2'));
    expect(userKeys.roles('u-1')).not.toEqual(userKeys.departments('u-1'));
    expect(userKeys.profile('u-1')).not.toEqual(userKeys.settings('u-1'));
    expect(userKeys.list()[0]).toBe('users');
  });
});

describe('users client — directory + lifecycle', () => {
  it('lists, creates, updates, flips status and soft-deletes', async () => {
    const calls = installFetchMock();
    await listUsers({ page: 0, search: 'anna' });
    await getUser('u-1');
    await createUser({ username: 'anna', password: 'pw-123456' });
    await updateUser('u-1', { username: 'anna.k' });
    await updateUserStatus('u-1', 'DISABLED');
    await deleteUser('u-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/users?page=0&search=anna',
      'GET /api/hope/admin/users/u-1',
      'POST /api/hope/admin/users',
      'PATCH /api/hope/admin/users/u-1',
      'PATCH /api/hope/admin/users/u-1/status',
      'DELETE /api/hope/admin/users/u-1',
    ]);
    expect(calls[4].body).toEqual({ resourceStatus: 'DISABLED' });
  });

  it('runs bulk actions and exports the directory', async () => {
    const calls = installFetchMock(() =>
      calls.length <= 1
        ? Response.json({ action: 'disable', total: 2, succeeded: 2, failed: 0, results: [] })
        : new Response(new Blob(['csv']), { headers: { 'content-type': 'text/csv' } }),
    );
    await bulkUserAction({ action: 'disable', ids: ['u-1', 'u-2'] });
    await exportUsers({ format: 'csv' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/admin/users/bulk-actions');
    expect(calls[1].url).toBe('/api/hope/admin/users/export?format=csv');
  });
});

describe('users client — sub-resources', () => {
  it('covers roles, departments (OCC PATCH), settings, profile, voice profiles, api keys', async () => {
    const calls = installFetchMock();
    await listUserRoles('u-1');
    await assignRole('u-1', { roleId: 'r-1' });
    await removeRole('u-1', 'assign-1');
    await listUserDepartments('u-1');
    await assignDepartment('u-1', { departmentId: 'd-1', isPrimary: true });
    await updateDepartment('u-1', 'ud-1', { isPrimary: false }, '"3"');
    await removeDepartment('u-1', 'ud-1');
    await setUserDepartments('u-1', { departmentIds: ['d-1', 'd-2'], primaryDepartmentId: 'd-1' });
    await listUserSettings('u-1');
    await updateUserSetting('u-1', 'ui', 'theme', { value: 'dark' });
    await getUserProfile('u-1');
    await updateUserProfile('u-1', { firstName: 'Anna' });
    await listVoiceProfiles('u-1');
    await listUserApiKeys('u-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/users/u-1/roles',
      'POST /api/hope/admin/users/u-1/roles',
      'DELETE /api/hope/admin/users/u-1/roles/assign-1',
      'GET /api/hope/admin/users/u-1/departments',
      'POST /api/hope/admin/users/u-1/departments',
      'PATCH /api/hope/admin/users/u-1/departments/ud-1',
      'DELETE /api/hope/admin/users/u-1/departments/ud-1',
      'PATCH /api/hope/admin/users/u-1/departments',
      'GET /api/hope/admin/users/u-1/settings',
      'PATCH /api/hope/admin/users/u-1/settings/ui/theme',
      'GET /api/hope/admin/users/u-1/profile',
      'PATCH /api/hope/admin/users/u-1/profile',
      'GET /api/hope/admin/users/u-1/voice-profiles',
      'GET /api/hope/admin/users/u-1/api-keys',
    ]);
    const deptPatch = calls[5];
    expect(deptPatch.headers.get('if-match')).toBe('"3"');
    expect(deptPatch.body).toEqual({ isPrimary: false, expectedVersion: 3 });
  });

  it('resets passwords in temporary and link modes', async () => {
    const calls = installFetchMock();
    await resetPassword('u-1', { mode: 'temporary' });
    expect(calls[0].url).toBe('/api/hope/admin/users/u-1/reset-password');
    expect(calls[0].body).toEqual({ mode: 'temporary' });
  });
});

describe('users client — impersonation (BFF-owned, not proxied)', () => {
  it('starts impersonation via the BFF auth route so the session captures the token', async () => {
    const calls = installFetchMock();
    await impersonateUser({ userId: 'u-9', targetTenantId: 't-2', reason: 'support' });
    expect(calls[0].url).toBe('/api/auth/impersonate');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ userId: 'u-9', targetTenantId: 't-2', reason: 'support' });
  });

  it('revokes impersonation via the BFF auth route', async () => {
    const calls = installFetchMock();
    await revokeImpersonation();
    expect(calls[0].url).toBe('/api/auth/revoke-impersonation');
    expect(calls[0].method).toBe('POST');
  });
});
