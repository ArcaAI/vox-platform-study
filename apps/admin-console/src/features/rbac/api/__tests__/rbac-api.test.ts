import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    assignPolicyToRole,
    createPolicy,
    createRole,
    deletePolicy,
    deleteRole,
    detachPolicyFromRole,
    getPolicy,
    getRole,
    listPolicies,
    listRoles,
    updatePolicy,
    updateRole,
    validatePolicyRules,
} from '../client';
import { rbacKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
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
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return response ? response() : Response.json({ id: 'r-1' });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('rbacKeys', () => {
    it('is stable and separates roles from policies', () => {
        expect(rbacKeys.roles({ page: 1 })).toEqual(rbacKeys.roles({ page: 1 }));
        expect(rbacKeys.roles()).not.toEqual(rbacKeys.policies());
        expect(rbacKeys.role('r-1')).not.toEqual(rbacKeys.policy('r-1'));
        expect(rbacKeys.roles()[0]).toBe('rbac');
    });
});

describe('rbac client — roles', () => {
    it('parses the RBAC-specific envelope { data, total, page, pageSize }', async () => {
        installFetchMock(() => Response.json({ data: [{ id: 'r-1', name: 'AUDITOR' }], total: 1, page: 1, pageSize: 20 }));
        const roles = await listRoles({ page: 1, pageSize: 20, search: 'aud' });
        expect(roles.total).toBe(1);
        expect(roles.pageSize).toBe(20);
        expect(roles.data[0].name).toBe('AUDITOR');
    });

    it('uses page/pageSize/search raw query params (not the shared ListParams)', async () => {
        const calls = installFetchMock();
        await listRoles({ page: 2, pageSize: 50, search: 'admin' });
        expect(calls[0].url).toBe('/api/hope/admin/rbac/roles?page=2&pageSize=50&search=admin');
    });

    it('does role CRUD and policy attach/detach with break-glass on destructive ops', async () => {
        const calls = installFetchMock();
        await getRole('r-1');
        await createRole({ name: 'AUDITOR' });
        await updateRole('r-1', { description: 'Read-only reviewer' });
        await assignPolicyToRole('r-1', 'p-1', 5);
        await detachPolicyFromRole('r-1', 'p-1', { password: 'pw', confirmationName: 'AUDITOR' });
        await deleteRole('r-1', { password: 'pw', confirmationName: 'AUDITOR' });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/rbac/roles/r-1',
            'POST /api/hope/admin/rbac/roles',
            'PATCH /api/hope/admin/rbac/roles/r-1',
            'POST /api/hope/admin/rbac/roles/r-1/policies/p-1',
            'DELETE /api/hope/admin/rbac/roles/r-1/policies/p-1',
            'DELETE /api/hope/admin/rbac/roles/r-1',
        ]);
        expect(calls[3].body).toEqual({ priority: 5 });
        expect(calls[4].body).toEqual({ password: 'pw', confirmationName: 'AUDITOR' });
        expect(calls[5].body).toEqual({ password: 'pw', confirmationName: 'AUDITOR' });
    });
});

describe('rbac client — policies', () => {
    it('lists with scope filter, does CRUD and validates rules', async () => {
        const calls = installFetchMock(() => Response.json({ valid: true }));
        await listPolicies({ scope: 'GLOBAL' });
        await getPolicy('p-1');
        await createPolicy({ name: 'auditor-read', scope: 'GLOBAL', rules: [{ action: 'read', subject: 'AuditLog' }] });
        await updatePolicy('p-1', { description: 'wider' });
        await deletePolicy('p-1', { password: 'pw', confirmationName: 'auditor-read' });
        const validation = await validatePolicyRules([{ action: 'manage', subject: 'all' }]);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/rbac/policies?scope=GLOBAL',
            'GET /api/hope/admin/rbac/policies/p-1',
            'POST /api/hope/admin/rbac/policies',
            'PATCH /api/hope/admin/rbac/policies/p-1',
            'DELETE /api/hope/admin/rbac/policies/p-1',
            'POST /api/hope/admin/rbac/policies/validate',
        ]);
        expect(calls[5].body).toEqual({ rules: [{ action: 'manage', subject: 'all' }] });
        expect(validation.valid).toBe(true);
    });
});
