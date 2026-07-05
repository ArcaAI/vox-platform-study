import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    archiveTenant,
    createTenant,
    getFrontendConfig,
    getTenant,
    getTenantTags,
    getTenantUsage,
    listTenantConfigs,
    listTenants,
    restoreTenant,
    setTenantTags,
    suspendTenant,
    updateFrontendConfig,
    updateTenant,
    updateTenantConfigs,
} from '../client';
import { tenantKeys } from '../keys';

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

describe('tenantKeys', () => {
    it('is stable for equal params and distinct across scopes', () => {
        expect(tenantKeys.list({ page: 0, limit: 25 })).toEqual(tenantKeys.list({ page: 0, limit: 25 }));
        expect(tenantKeys.detail('t-1')).toEqual(tenantKeys.detail('t-1'));
        expect(tenantKeys.detail('t-1')).not.toEqual(tenantKeys.detail('t-2'));
        expect(tenantKeys.list()).not.toEqual(tenantKeys.detail('t-1'));
        expect(tenantKeys.usage('t-1')).not.toEqual(tenantKeys.tags('t-1'));
    });

    it('roots every key under the domain namespace for coarse invalidation', () => {
        for (const key of [tenantKeys.list(), tenantKeys.detail('x'), tenantKeys.usage('x'), tenantKeys.tags('x'), tenantKeys.configs('x'), tenantKeys.frontendConfig()]) {
            expect(key[0]).toBe('tenants');
        }
    });
});

describe('tenants client', () => {
    it('lists tenants through the proxy with pagination params', async () => {
        const calls = installFetchMock(() => Response.json({ data: [], count: 0, limit: 25, page: 0 }));
        await listTenants({ page: 0, limit: 25, search: 'north' });
        expect(calls[0].url).toBe('/api/hope/admin/tenants?page=0&limit=25&search=north');
        expect(calls[0].method).toBe('GET');
    });

    it('captures the ETag on a tenant read for the later PATCH', async () => {
        installFetchMock(() => Response.json({ id: 't-1', version: 7 }, { headers: { etag: '"7"' } }));
        const read = await getTenant('t-1');
        expect(read.etag).toBe('"7"');
        expect(read.data.version).toBe(7);
    });

    it('updates a tenant with If-Match AND the body expectedVersion (OCC contract)', async () => {
        const calls = installFetchMock(() => Response.json({ id: 't-1', version: 8 }, { headers: { etag: '"8"' } }));
        await updateTenant('t-1', { name: 'Northwind' }, '"7"');
        expect(calls[0].url).toBe('/api/hope/admin/tenants/t-1');
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].headers.get('if-match')).toBe('"7"');
        expect(calls[0].body).toEqual({ name: 'Northwind', expectedVersion: 7 });
    });

    it('creates and runs lifecycle transitions as POSTs on the documented paths', async () => {
        const calls = installFetchMock(() => Response.json({ id: 't-1' }));
        await createTenant({ name: 'North', key: 'north' });
        await suspendTenant('t-1');
        await archiveTenant('t-1');
        await restoreTenant('t-1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/hope/admin/tenants',
            'POST /api/hope/admin/tenants/t-1/suspend',
            'POST /api/hope/admin/tenants/t-1/archive',
            'POST /api/hope/admin/tenants/t-1/restore',
        ]);
    });

    it('reads usage and round-trips tags', async () => {
        const calls = installFetchMock(() => Response.json({ tags: ['pilot'] }));
        await getTenantUsage('t-1');
        await getTenantTags('t-1');
        await setTenantTags('t-1', ['pilot', 'emea']);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/tenants/t-1/usage',
            'GET /api/hope/admin/tenants/t-1/tags',
            'PUT /api/hope/admin/tenants/t-1/tags',
        ]);
        expect(calls[2].body).toEqual({ tags: ['pilot', 'emea'] });
    });

    it('bulk-updates tenant configs with per-row expectedVersion (no If-Match)', async () => {
        const calls = installFetchMock(() => Response.json({ data: [], count: 0, limit: 10, page: 0 }));
        await listTenantConfigs('t-1', { page: 0 });
        await updateTenantConfigs('t-1', [{ id: 'cfg-1', value: 'on', expectedVersion: 3 }]);
        expect(calls[0].url).toBe('/api/hope/admin/tenants/configs/t-1?page=0');
        expect(calls[1].method).toBe('PATCH');
        expect(calls[1].headers.get('if-match')).toBeNull();
        expect(calls[1].body).toEqual([{ id: 'cfg-1', value: 'on', expectedVersion: 3 }]);
    });

    it('reads and upserts the frontend pipeline config (optional tenantId targeting)', async () => {
        const calls = installFetchMock(() => Response.json({ id: 'cfg', tenantId: 't-1', version: 2 }, { headers: { etag: '"2"' } }));
        const read = await getFrontendConfig('t-1');
        expect(read.etag).toBe('"2"');
        await updateFrontendConfig({ vad: true, expectedVersion: 2 }, '"2"', 't-1');
        expect(calls[0].url).toBe('/api/hope/admin/tenant-frontend-config?tenantId=t-1');
        expect(calls[1].method).toBe('PUT');
        expect(calls[1].url).toBe('/api/hope/admin/tenant-frontend-config?tenantId=t-1');
        expect(calls[1].headers.get('if-match')).toBe('"2"');
    });
});
