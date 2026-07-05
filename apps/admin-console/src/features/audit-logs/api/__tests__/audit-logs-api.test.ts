import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportAuditLogs, getAuditLog, listAuditLogs, listAuditLogsByCursor, listResourceAuditLogs, listUserAuditLogs } from '../client';
import { auditLogKeys } from '../keys';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('auditLogKeys', () => {
    it('is stable and separates offset, cursor and scoped lists', () => {
        expect(auditLogKeys.list({ page: 0 })).toEqual(auditLogKeys.list({ page: 0 }));
        expect(auditLogKeys.cursor({ limit: 50 })).not.toEqual(auditLogKeys.list({ limit: 50 }));
        expect(auditLogKeys.byResource('Tenant', 't-1')).not.toEqual(auditLogKeys.byUser('t-1'));
        expect(auditLogKeys.list()[0]).toBe('audit-logs');
    });
});

describe('audit-logs client', () => {
    it('passes time-range and facet filters to the offset list', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ data: [], count: 0, limit: 25, page: 0 }));
        vi.stubGlobal('fetch', fetchMock);
        await listAuditLogs({ page: 0, from: '2026-07-01T00:00:00Z', action: 'UPDATE', resourceType: 'Tenant' });
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toContain('/api/hope/admin/audit-logs?');
        expect(url).toContain('from=2026-07-01T00%3A00%3A00Z');
        expect(url).toContain('action=UPDATE');
        expect(url).toContain('resourceType=Tenant');
    });

    it('walks the cursor endpoint and surfaces nextCursor/hasMore', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ data: [{ id: 'a-1' }], nextCursor: 'a-1', hasMore: true, limit: 50 })),
        );
        const pageOne = await listAuditLogsByCursor({ limit: 50 });
        expect(pageOne.nextCursor).toBe('a-1');
        expect(pageOne.hasMore).toBe(true);
    });

    it('reads detail and the resource/user scoped lists', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ data: [], count: 0, limit: 25, page: 0 }));
        vi.stubGlobal('fetch', fetchMock);
        await getAuditLog('a-1');
        await listResourceAuditLogs('Tenant', 't-1');
        await listUserAuditLogs('u-1');
        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            '/api/hope/admin/audit-logs/a-1',
            '/api/hope/admin/audit-logs/resource/Tenant/t-1',
            '/api/hope/admin/audit-logs/user/u-1',
        ]);
    });

    it('downloads the export as a Blob with the served content-type', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(new Blob(['id,action\n']), { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="audit.csv"' } })),
        );
        const download = await exportAuditLogs({ format: 'csv' });
        expect(download.contentType).toBe('text/csv');
        expect(download.contentDisposition).toContain('audit.csv');
        expect(await download.blob.text()).toBe('id,action\n');
    });
});
