import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlobalSetting, deleteGlobalSetting, getGlobalSetting, listGlobalSettings, listTenantScopedSettings, revealGlobalSetting, updateGlobalSetting } from '../client';
import { settingKeys } from '../keys';

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
            return response ? response() : Response.json({ id: 's-1', version: 2 }, { headers: { etag: '"2"' } });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('settingKeys', () => {
    it('is stable and scopes tenant-filtered lists separately', () => {
        expect(settingKeys.list({ page: 0 })).toEqual(settingKeys.list({ page: 0 }));
        expect(settingKeys.byTenant('t-1')).not.toEqual(settingKeys.list());
        expect(settingKeys.detail('s-1')[0]).toBe('settings');
    });
});

describe('settings client', () => {
    it('lists, reads (ETag captured), creates', async () => {
        const calls = installFetchMock();
        await listGlobalSettings({ search: 'smtp' });
        await listTenantScopedSettings('t-1');
        const read = await getGlobalSetting('s-1');
        await createGlobalSetting({ name: 'SMTP host', key: 'smtp.host', value: 'mail.local', dataType: 'String' });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/settings?search=smtp',
            'GET /api/hope/admin/settings/tenant/t-1',
            'GET /api/hope/admin/settings/s-1',
            'POST /api/hope/admin/settings',
        ]);
        expect(read.etag).toBe('"2"');
    });

    it('PATCHes with If-Match + expectedVersion and deletes', async () => {
        const calls = installFetchMock();
        await updateGlobalSetting('s-1', { value: 'mail2.local' }, '"2"');
        await deleteGlobalSetting('s-1');
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].headers.get('if-match')).toBe('"2"');
        expect(calls[0].body).toEqual({ value: 'mail2.local', expectedVersion: 2 });
        expect(calls[1].method).toBe('DELETE');
    });

    it('reveals a secret value with the step-up password', async () => {
        const calls = installFetchMock(() => Response.json({ id: 's-1', key: 'smtp.password', value: 'hunter2', revealedAt: 'now' }));
        const revealed = await revealGlobalSetting('s-1', 'admin-password');
        expect(calls[0].url).toBe('/api/hope/admin/settings/s-1/reveal');
        expect(calls[0].method).toBe('POST');
        expect(calls[0].body).toEqual({ password: 'admin-password' });
        expect(revealed.value).toBe('hunter2');
    });
});
