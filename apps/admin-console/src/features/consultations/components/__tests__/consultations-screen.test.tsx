/**
 * Frame 40 — Consultations screen. fetch is stubbed at the network boundary
 * (the api layer has its own tests); assertions cover the row 33 scope
 * branching (aggregate-only view vs full screen), the filter -> list query
 * mapping, the client-side type filter, the row-click read-only detail and
 * the error states (list and aggregate fail independently).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Consultation, ConsultationAggregate } from '../../api/types';
import { ConsultationsScreen } from '../consultations-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

// recharts' ResponsiveContainer relies on layout measurement that happy-dom
// lacks; inject a fixed size so MetricChart actually draws (standard shim).
// recharts is a transitive dep (via @arcaai/ui), so its types are not
// resolvable from this app — keep the module shape untyped.
vi.mock('recharts', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
            React.cloneElement(children, { width: 800, height: 300 }),
    };
});

beforeAll(() => {
    Element.prototype.getBoundingClientRect = function () {
        return { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null; roles: string[] }> = {}) {
    const { roles = ['SUPER_ADMIN'], ...rest } = overrides;
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles },
        isElevated: true,
        workingTenantId: 't-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...rest,
    };
}

function consultation(overrides: Partial<Consultation> = {}): Consultation {
    return {
        id: 'c_9f2ka7aa11',
        patientId: 'pt_44s1x9',
        doctorId: 'usr-vasquez',
        doctor: { id: 'usr-vasquez', username: 'dr.vasquez' },
        departmentId: 'dep-card',
        department: { id: 'dep-card', code: 'CARD', name: 'Cardiology' },
        appointmentDate: '2026-07-04',
        status: 'SIGNED',
        createdAt: '2026-07-04T14:02:00.000Z',
        updatedAt: '2026-07-04T15:00:00.000Z',
        ...overrides,
    };
}

const ROWS: Consultation[] = [
    consultation(),
    consultation({
        id: 'c_8p6qy2bb22',
        doctorId: 'usr-chen',
        doctor: { id: 'usr-chen', username: 'dr.chen' },
        parentConsultationId: 'c_9f2ka7aa11',
        status: 'CLOSED',
    }),
];

const DETAIL: Consultation = {
    ...consultation(),
    contextItems: [
        { id: 'ctx-1', consultationId: 'c_9f2ka7aa11', type: 'TRANSCRIPT', source: 'SYSTEM', createdAt: '2026-07-04T14:10:00.000Z', updatedAt: '2026-07-04T14:10:00.000Z' },
        { id: 'ctx-2', consultationId: 'c_9f2ka7aa11', type: 'RAW_SUMMARY', source: 'AI', createdAt: '2026-07-04T14:20:00.000Z', updatedAt: '2026-07-04T14:20:00.000Z' },
        { id: 'ctx-3', consultationId: 'c_9f2ka7aa11', type: 'MODIFIED_SUMMARY', source: 'USER', createdAt: '2026-07-04T14:30:00.000Z', updatedAt: '2026-07-04T14:30:00.000Z' },
    ],
};

const AGGREGATE: ConsultationAggregate = {
    buckets: [
        { key: '2026-05', label: 'May', start: '2026-05-01T00:00:00.000Z', end: '2026-05-31T23:59:59.999Z', newVisits: 270, revisits: 88, total: 358 },
        { key: '2026-06', label: 'Jun', start: '2026-06-01T00:00:00.000Z', end: '2026-06-30T23:59:59.999Z', newVisits: 289, revisits: 101, total: 390 },
        { key: '2026-07', label: 'Jul', start: '2026-07-01T00:00:00.000Z', end: '2026-07-31T23:59:59.999Z', newVisits: 312, revisits: 128, total: 440 },
    ],
    totals: { total: 1188, newVisits: 871, revisits: 317 },
    granularity: 'month',
    refreshedAt: '2026-07-05T07:00:00.000Z',
};

interface RecordedCall {
    url: string;
    method: string;
}

type FetchHandler = (call: RecordedCall, parsed: URL) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
            calls.push(call);
            const response = handler(call, new URL(call.url, 'http://test.local'));
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function listResponse(rows: Consultation[], count: number, page = 1, limit = 25): Response {
    return Response.json({ data: rows, count, page, limit });
}

/** Full-view routes: elevated session pinned to a working tenant. */
function defaultHandler(call: RecordedCall, parsed: URL): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = parsed.pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/consultations/aggregate') return Response.json(AGGREGATE);
    if (path === '/api/hope/admin/consultations/c_9f2ka7aa11') return Response.json(DETAIL);
    if (path === '/api/hope/admin/consultations') return listResponse(ROWS, 1842);
    return undefined;
}

function stubConsultations(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call, parsed) => custom(call, parsed) ?? defaultHandler(call, parsed));
}

function listCalls(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/consultations');
}

function queryOf(url: string): URLSearchParams {
    return new URLSearchParams(url.split('?')[1] ?? '');
}

describe('ConsultationsScreen', () => {
    it('renders the aggregate-only view (no grid, no list query) for an elevated session without a working tenant', async () => {
        const calls = stubConsultations((call, parsed) => {
            if (parsed.pathname === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<ConsultationsScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Consultations' })).toBeDefined();
        expect(await screen.findByText(/select a working tenant to browse consultation rows/i)).toBeDefined();
        expect(screen.getByText(/New vs revisit/)).toBeDefined();
        // Aggregate totals rendered from the cross-tenant payload.
        expect(await screen.findByText(/871 new/)).toBeDefined();
        // The row 33 exception: aggregate INSTEAD of a gate...
        expect(screen.queryByText('Select a working tenant')).toBeNull();
        // ...and no consultation grid, no row fetch (rows require tenant scope).
        expect(screen.queryByRole('table', { name: 'Consultations' })).toBeNull();
        await waitFor(() => expect(calls.some((call) => call.url.includes('/consultations/aggregate'))).toBe(true));
        expect(listCalls(calls)).toHaveLength(0);
    });

    it('renders the full grid with rows, aggregate card and count meta when a working tenant is set', async () => {
        stubConsultations();
        renderWithProviders(<ConsultationsScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Consultations' })).toBeDefined();
        const table = await screen.findByRole('table', { name: 'Consultations' });
        expect(await within(table).findByText('dr.vasquez')).toBeDefined();
        expect(within(table).getByText('dr.chen')).toBeDefined();
        expect(within(table).getByText('c_9f2ka7aa11')).toBeDefined();
        // Type derives from parentConsultationId (no dedicated DTO field).
        expect(within(table).getByText('New')).toBeDefined();
        expect(within(table).getByText('Revisit')).toBeDefined();
        expect(within(table).getByText('Signed')).toBeDefined();
        expect(within(table).getByText('Closed')).toBeDefined();
        expect(await screen.findByText(/1,842 consultations/)).toBeDefined();
        expect(screen.getByText(/871 new/)).toBeDefined();
        expect(screen.getByRole('button', { name: /refresh/i })).toBeDefined();
    });

    it('maps URL filter state onto the list query (1-based page, status param, never a type param)', async () => {
        const calls = stubConsultations();
        renderWithProviders(<ConsultationsScreen />, {
            searchParams: '?status=SIGNED&patientId=pt_44s1x9&doctorId=usr-vasquez&departmentId=dep-card&type=revisit&page=1',
        });

        await screen.findByRole('table', { name: 'Consultations' });
        const request = listCalls(calls)[0];
        expect(request).toBeDefined();
        const params = queryOf(request.url);
        expect(params.get('status')).toBe('SIGNED');
        expect(params.get('patientId')).toBe('pt_44s1x9');
        expect(params.get('doctorId')).toBe('usr-vasquez');
        expect(params.get('departmentId')).toBe('dep-card');
        // URL page=1 (0-based UI) -> wire page=2 (this endpoint is 1-based).
        expect(params.get('page')).toBe('2');
        // The API has no type param — new/revisit filters the loaded page only.
        expect(params.has('type')).toBe(false);
        // Client-side type=revisit keeps only the revisit row.
        const table = screen.getByRole('table', { name: 'Consultations' });
        expect(await within(table).findByText('dr.chen')).toBeDefined();
        expect(within(table).queryByText('dr.vasquez')).toBeNull();
    });

    it('issues a fresh list request when the status filter changes', async () => {
        const calls = stubConsultations();
        renderWithProviders(<ConsultationsScreen />);

        await screen.findByText('dr.vasquez');
        fireEvent.click(screen.getByLabelText('Status:'));
        fireEvent.click(await screen.findByRole('option', { name: 'Recording' }));
        await waitFor(() => {
            expect(listCalls(calls).some((call) => queryOf(call.url).get('status') === 'RECORDING')).toBe(true);
        });
    });

    it('opens the read-only detail panel on row click: GET :id, masked patient, relations summary', async () => {
        const calls = stubConsultations();
        renderWithProviders(<ConsultationsScreen />);

        fireEvent.click(await screen.findByText('dr.vasquez'));

        const dialog = await screen.findByRole('dialog');
        await waitFor(() =>
            expect(calls.some((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/consultations/c_9f2ka7aa11')).toBe(true),
        );
        // Patient id is masked to a short prefix per the frame.
        expect(await within(dialog).findByText('pt_44s1\u2026')).toBeDefined();
        expect(within(dialog).getByText('(masked)')).toBeDefined();
        expect(within(dialog).queryByText('pt_44s1x9')).toBeNull();
        expect(within(dialog).getByText('dr.vasquez')).toBeDefined();
        expect(within(dialog).getByText(/Cardiology/)).toBeDefined();
        // Relations summary from the contextItems the DTO actually carries.
        expect(within(dialog).getByText('Transcript')).toBeDefined();
        expect(within(dialog).getByText('Summary')).toBeDefined();
        expect(within(dialog).getByText(/no mutations; a plain DOCTOR never passes this guard/i)).toBeDefined();
        expect(within(dialog).getByRole('button', { name: 'Copy consultation id' })).toBeDefined();
    });

    it('shows the filtered empty state with a clear-filters action', async () => {
        stubConsultations((call, parsed) => {
            if (call.method === 'GET' && parsed.pathname === '/api/hope/admin/consultations') return listResponse([], 0);
            return undefined;
        });
        renderWithProviders(<ConsultationsScreen />, { searchParams: '?status=REOPENED' });

        expect(await screen.findByText('No consultations in range')).toBeDefined();
        expect(screen.getByRole('button', { name: /clear filters/i })).toBeDefined();
    });

    it('keeps the aggregate card when the list errors — the queries are independent', async () => {
        const calls = stubConsultations((call, parsed) => {
            if (call.method === 'GET' && parsed.pathname === '/api/hope/admin/consultations') {
                return Response.json({ message: 'Consultations API unreachable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<ConsultationsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/consultations api unreachable/i)).toBeDefined();
        // The aggregate query is independent: its card still renders data.
        expect(await screen.findByText(/871 new/)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(listCalls(calls).length).toBe(2));
    });

    it('keeps the layout skeleton while the session is loading', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { container } = renderWithProviders(<ConsultationsScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.getByRole('heading', { level: 1, name: 'Consultations' })).toBeDefined();
    });
});
