/**
 * Frame 18 — Audit logs screen. fetch is stubbed at the network boundary (the
 * api layer has its own tests); assertions cover the rendered rows, the
 * filter -> cursor-request mapping, the cursor-stack prev/next flow, the JSON
 * detail drawer, the Blob export download, and the three list states.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AuditLog } from '../../api/types';
import { AuditLogsScreen } from '../audit-logs-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const BASE = '/api/hope/admin/audit-logs';

function auditLog(overrides: Partial<AuditLog> = {}): AuditLog {
    return {
        id: 'log-1',
        projectId: null,
        createdAt: '2026-07-04T13:58:12.000Z',
        updatedAt: '2026-07-04T13:58:12.000Z',
        resourceStatus: null,
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        createdBy: null,
        updatedBy: null,
        tenantId: 'tnt_9f2ka7',
        responsibleUserId: 'usr-ana',
        responsibleIp: '10.0.0.7',
        resourceType: 'Tenant',
        resourceId: 'tnt_9f2ka7',
        action: 'UPDATE',
        eventType: null,
        success: true,
        data: { plan: 'ENTERPRISE' },
        previousData: { plan: 'PRO' },
        metadata: null,
        responsibleUser: { id: 'usr-ana', displayName: 'Ana', email: 'ana@arca.ai' },
        ...overrides,
    };
}

const PAGE_ONE: AuditLog[] = [
    auditLog(),
    auditLog({
        id: 'log-2',
        action: 'CREATE',
        eventType: 'schedule.run',
        success: false,
        resourceType: 'GlobalSetting',
        resourceId: null,
        responsibleUserId: null,
        responsibleUser: null,
        data: null,
        previousData: null,
    }),
];

const PAGE_TWO: AuditLog[] = [
    auditLog({ id: 'log-3', responsibleUserId: 'usr-liam', responsibleUser: { id: 'usr-liam', displayName: 'Liam', email: 'liam@arca.ai' } }),
];

interface RecordedCall {
    url: string;
    method: string;
}

/** Query params without relying on the global URL (stubbed in the export test). */
function queryOf(url: string): URLSearchParams {
    return new URLSearchParams(url.split('?')[1] ?? '');
}

function stubFetch(handler: (url: string) => Response | undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({ url, method });
            // Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved layout in tests.
            if (url.includes('/user/me/settings')) return method === 'GET' ? Response.json([]) : Response.json({ ok: true });
            const response = handler(url);
            if (!response) throw new Error(`Unhandled fetch: ${method} ${url}`);
            return response;
        }),
    );
    return calls;
}

function cursorResponse(rows: AuditLog[], nextCursor: string | null): Response {
    return Response.json({ data: rows, nextCursor, hasMore: nextCursor !== null, limit: 25 });
}

/** The meta/filter-bar total comes from the offset list envelope's count. */
function countResponse(count: number): Response {
    return Response.json({ data: [], count, limit: 1, page: 0 });
}

/** useTenantNames probes the shared tenant catalog through the BFF proxy. */
const TENANTS_BASE = '/api/hope/admin/tenants';

interface CatalogTenant {
    id: string;
    name: string;
    key: string;
}

const ACME_CATALOG: CatalogTenant[] = [{ id: 'tnt_9f2ka7', name: 'Acme Clinic', key: 'acme' }];

function tenantCatalogResponse(tenants: CatalogTenant[] = ACME_CATALOG): Response {
    return Response.json({ data: tenants, count: tenants.length, limit: 500, page: 0 });
}

function stubAuditRoutes(tenants: CatalogTenant[] = ACME_CATALOG): RecordedCall[] {
    return stubFetch((url) => {
        if (url.startsWith(`${TENANTS_BASE}?`)) return tenantCatalogResponse(tenants);
        if (url.startsWith(`${BASE}/cursor`)) {
            const cursor = queryOf(url).get('cursor');
            if (cursor === 'cur-2') return cursorResponse(PAGE_TWO, null);
            return cursorResponse(PAGE_ONE, 'cur-2');
        }
        if (url.startsWith(`${BASE}?`)) return countResponse(38_204);
        return undefined;
    });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('AuditLogsScreen', () => {
    it('renders audit rows with actor, action, target and result', async () => {
        stubAuditRoutes();
        renderWithProviders(<AuditLogsScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Audit logs' })).toBeDefined();
        expect(await screen.findByText('ana@arca.ai')).toBeDefined();
        expect(screen.getByText('system')).toBeDefined();
        expect(screen.getByText('UPDATE')).toBeDefined();
        // Tenant column resolves the id to a human-readable name; the id stays as metadata.
        expect((await screen.findAllByText('Acme Clinic')).length).toBeGreaterThan(0);
        expect(screen.getAllByText('tnt_9f2ka7').length).toBeGreaterThan(0);
        expect(screen.getByText('OK')).toBeDefined();
        expect(screen.getByText('Fail')).toBeDefined();
        expect(screen.getByRole('grid', { name: 'Audit events' })).toBeDefined();
        expect(await screen.findByText(/38,204 events/)).toBeDefined();
    });

    it('falls back to the raw tenant id when the tenant is not in the catalog', async () => {
        stubAuditRoutes([{ id: 'tnt_other', name: 'Other Clinic', key: 'other' }]);
        renderWithProviders(<AuditLogsScreen />);

        await screen.findByText('ana@arca.ai');
        // The row's tenant is unresolved, so the raw id renders and no name shows.
        expect(screen.getAllByText('tnt_9f2ka7').length).toBeGreaterThan(0);
        expect(screen.queryByText('Acme Clinic')).toBeNull();
    });

    it('maps URL query-state onto the discrete cursor request and never sends search/filters', async () => {
        // The grid's shareable state lives in the URL codec: omni search → actor id,
        // typed filters in the compact `f` param (JSON tuples). The screen-local hook
        // maps them onto the cursor DTO's whitelisted discrete knobs.
        const f = encodeURIComponent(
            JSON.stringify([
                ['action', 'eq', 'select', 'UPDATE'],
                ['resourceType', 'eq', 'select', 'Tenant'],
                ['createdAt', 'isBetween', 'dateRange', ['2026-07-01', '2026-07-02']],
            ]),
        );
        const calls = stubAuditRoutes();
        renderWithProviders(<AuditLogsScreen />, { searchParams: `?search=usr-ana&f=${f}&limit=50` });

        await screen.findByText('ana@arca.ai');
        const cursorCall = calls.find((call) => call.url.startsWith(`${BASE}/cursor`));
        expect(cursorCall).toBeDefined();
        const params = queryOf(cursorCall!.url);
        expect(params.get('action')).toBe('UPDATE');
        expect(params.get('resourceType')).toBe('Tenant');
        // Omni search targets the actor id (the frame's primary text filter).
        expect(params.get('userId')).toBe('usr-ana');
        expect(params.get('limit')).toBe('50');
        // The dateRange filter maps to day-bounded ISO-8601 instants (gateway @IsISO8601).
        expect(params.get('from')).toBe('2026-07-01T00:00:00.000Z');
        expect(params.get('to')).toBe('2026-07-02T23:59:59.999Z');
        // The cursor DTO whitelists only discrete knobs — generic search/filters/sort are never sent.
        expect(params.has('search')).toBe(false);
        expect(params.has('filters')).toBe(false);
        expect(params.has('sort')).toBe(false);
        // The meta/total count follows the same filters via the offset list.
        const countCall = calls.find((call) => call.url.startsWith(`${BASE}?`));
        expect(countCall).toBeDefined();
        expect(queryOf(countCall!.url).get('action')).toBe('UPDATE');
    });

    it('issues a fresh cursor request when the actor omni-search changes', async () => {
        const calls = stubAuditRoutes();
        renderWithProviders(<AuditLogsScreen />);

        await screen.findByText('ana@arca.ai');
        // Omni search debounces (300ms) then commits as the `userId` cursor knob.
        fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'usr-7' } });
        await waitFor(() => {
            expect(calls.some((call) => call.url.startsWith(`${BASE}/cursor`) && queryOf(call.url).get('userId') === 'usr-7')).toBe(true);
        });
    });

    it('pages forward and back through the cursor stack', async () => {
        const calls = stubAuditRoutes();
        renderWithProviders(<AuditLogsScreen />);

        await screen.findByText('ana@arca.ai');
        expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText('liam@arca.ai')).toBeDefined();
        expect(calls.some((call) => call.url.startsWith(`${BASE}/cursor`) && queryOf(call.url).get('cursor') === 'cur-2')).toBe(true);
        expect(screen.queryByText('ana@arca.ai')).toBeNull();
        // Last page: hasMore=false disables Next.
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(await screen.findByText('ana@arca.ai')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
    });

    it('opens the JSON detail drawer on row click', async () => {
        stubAuditRoutes();
        renderWithProviders(<AuditLogsScreen />);

        fireEvent.click(await screen.findByText('ana@arca.ai'));
        expect(await screen.findByText(/"plan": "ENTERPRISE"/)).toBeDefined();
        expect(screen.getByText(/"plan": "PRO"/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Copy audit log id' })).toBeDefined();
        expect(screen.getAllByText('log-1').length).toBeGreaterThan(0);
    });

    it('exports with the chosen format and current filters, downloading the blob', async () => {
        const createObjectURL = vi.fn(() => 'blob:audit');
        const revokeObjectURL = vi.fn();
        // happy-dom would actually navigate the anchor; intercept the download click.
        const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const calls = stubFetch((url) => {
            if (url.startsWith(`${TENANTS_BASE}?`)) return tenantCatalogResponse();
            if (url.startsWith(`${BASE}/export`)) {
                return new Response('binary-xlsx', {
                    status: 200,
                    headers: {
                        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        'content-disposition': 'attachment; filename="audit-events.xlsx"',
                    },
                });
            }
            if (url.startsWith(`${BASE}/cursor`)) return cursorResponse(PAGE_ONE, null);
            if (url.startsWith(`${BASE}?`)) return countResponse(2);
            return undefined;
        });
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        const f = encodeURIComponent(JSON.stringify([['action', 'eq', 'select', 'UPDATE']]));
        renderWithProviders(<AuditLogsScreen />, { searchParams: `?f=${f}` });

        await screen.findByText('ana@arca.ai');
        fireEvent.keyDown(screen.getByRole('button', { name: /export/i }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'XLSX' }));

        await waitFor(() => {
            const exportCall = calls.find((call) => call.url.startsWith(`${BASE}/export`));
            expect(exportCall).toBeDefined();
            expect(queryOf(exportCall!.url).get('format')).toBe('xlsx');
            expect(queryOf(exportCall!.url).get('action')).toBe('UPDATE');
        });
        await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
        expect(anchorClick).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:audit');
        expect(toast.success).toHaveBeenCalled();
        anchorClick.mockRestore();
    });

    it('shows the filtered empty state with a clear-filters action', async () => {
        stubFetch((url) => {
            if (url.startsWith(`${TENANTS_BASE}?`)) return tenantCatalogResponse();
            if (url.startsWith(`${BASE}/cursor`)) return cursorResponse([], null);
            if (url.startsWith(`${BASE}?`)) return countResponse(0);
            return undefined;
        });
        const f = encodeURIComponent(JSON.stringify([['action', 'eq', 'select', 'DELETE']]));
        renderWithProviders(<AuditLogsScreen />, { searchParams: `?f=${f}` });

        expect(await screen.findByText('No events match the filters')).toBeDefined();
        // Both the toolbar and the filtered-empty CTA expose a clear affordance.
        expect(screen.getAllByRole('button', { name: /clear filters/i }).length).toBeGreaterThanOrEqual(1);
    });

    it('shows a neutral empty state when there are no events at all', async () => {
        stubFetch((url) => {
            if (url.startsWith(`${TENANTS_BASE}?`)) return tenantCatalogResponse();
            if (url.startsWith(`${BASE}/cursor`)) return cursorResponse([], null);
            if (url.startsWith(`${BASE}?`)) return countResponse(0);
            return undefined;
        });
        renderWithProviders(<AuditLogsScreen />);

        expect(await screen.findByText('No audit events yet')).toBeDefined();
        expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull();
    });

    it('shows a block error state and retries the cursor request', async () => {
        let fail = true;
        const calls = stubFetch((url) => {
            if (url.startsWith(`${TENANTS_BASE}?`)) return tenantCatalogResponse();
            if (url.startsWith(`${BASE}/cursor`)) {
                if (fail) return Response.json({ message: 'Audit API unreachable' }, { status: 503 });
                return cursorResponse(PAGE_ONE, null);
            }
            if (url.startsWith(`${BASE}?`)) return countResponse(2);
            return undefined;
        });
        renderWithProviders(<AuditLogsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/audit api unreachable/i)).toBeDefined();
        fail = false;
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => call.url.startsWith(`${BASE}/cursor`)).length).toBe(2));
        expect(await screen.findByText('ana@arca.ai')).toBeDefined();
    });
});
