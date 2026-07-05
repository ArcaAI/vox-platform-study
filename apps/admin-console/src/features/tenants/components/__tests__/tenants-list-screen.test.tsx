/**
 * Frame 12 — Tenants list screen. fetch is stubbed at the network boundary
 * (the api layer has its own tests); assertions here are the rendered list
 * states, the request URLs the filters produce, and the wizard POST.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Tenant } from '../../api/types';
import { TenantsListScreen } from '../tenants-list-screen';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function tenant(overrides: Partial<Tenant> = {}): Tenant {
    return {
        id: 't-1',
        projectId: null,
        createdAt: '2025-03-02T10:00:00.000Z',
        updatedAt: '2025-06-28T10:00:00.000Z',
        resourceStatus: 'ENABLED',
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        createdBy: null,
        updatedBy: null,
        version: 7,
        name: 'Sunrise Medical Group',
        key: 'tnt_9f2ka7',
        description: 'Flagship clinic network',
        plan: 'ENTERPRISE',
        tags: ['pilot'],
        ...overrides,
    };
}

const TENANTS = [
    tenant(),
    tenant({ id: 't-2', name: 'Bayview Health Network', key: 'tnt_4h8mz1', plan: 'PRO', resourceStatus: 'SUSPENDED' }),
];

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
            const response = handler(url, init);
            if (!response) throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
            return response;
        }),
    );
    return calls;
}

function listResponse(rows: Tenant[]): Response {
    return Response.json({ data: rows, count: rows.length, limit: 25, page: 0 });
}

afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    cleanup();
});

describe('TenantsListScreen', () => {
    it('renders tenant rows with key, plan and status from the list payload', async () => {
        stubFetch(() => listResponse(TENANTS));
        renderWithProviders(<TenantsListScreen />);

        expect(await screen.findByText('Sunrise Medical Group')).toBeDefined();
        expect(screen.getByText('Bayview Health Network')).toBeDefined();
        expect(screen.getByText('tnt_4h8mz1')).toBeDefined();
        expect(screen.getByText('Enterprise')).toBeDefined();
        expect(screen.getByText('Suspended')).toBeDefined();
        expect(screen.getByText(/2 tenants/i)).toBeDefined();
    });

    it('shows the no-tenants empty state with a create CTA when the list is empty', async () => {
        stubFetch(() => listResponse([]));
        renderWithProviders(<TenantsListScreen />);

        expect(await screen.findByText(/no tenants yet/i)).toBeDefined();
        // Header action + empty-state CTA both offer the create entry point.
        expect(screen.getAllByRole('button', { name: /new tenant/i }).length).toBeGreaterThanOrEqual(2);
    });

    it('offers Clear filters instead of the create CTA when filters match nothing', async () => {
        stubFetch(() => listResponse([]));
        renderWithProviders(<TenantsListScreen />, { searchParams: '?search=zzz' });

        expect(await screen.findByText(/no tenants match/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /clear filters/i })).toBeDefined();
    });

    it('renders the block error state and retries the request', async () => {
        const calls = stubFetch(() => Response.json({ message: 'Service unavailable' }, { status: 503 }));
        renderWithProviders(<TenantsListScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.length).toBe(2));
    });

    it('maps search/status/plan/page URL state onto the gateway list request', async () => {
        const calls = stubFetch(() => listResponse(TENANTS));
        renderWithProviders(<TenantsListScreen />, { searchParams: '?search=north&status=SUSPENDED&plan=PRO&page=1&limit=50' });

        await screen.findByText('Sunrise Medical Group');
        const requested = new URL(calls[0].url, 'http://test.local');
        expect(requested.pathname).toBe('/api/hope/admin/tenants');
        expect(requested.searchParams.get('search')).toBe('north');
        expect(requested.searchParams.get('searchFields')).toBe('name,key');
        expect(requested.searchParams.get('filters')).toBe('resourceStatus:SUSPENDED,plan:PRO');
        expect(requested.searchParams.get('page')).toBe('1');
        expect(requested.searchParams.get('limit')).toBe('50');
    });

    it('requests the default sort and reflects header sorting in the URL state', async () => {
        const calls = stubFetch(() => listResponse(TENANTS));
        const onUrlUpdate = vi.fn();
        renderWithProviders(<TenantsListScreen />, { onUrlUpdate });

        await screen.findByText('Sunrise Medical Group');
        expect(new URL(calls[0].url, 'http://test.local').searchParams.get('sort')).toBe('updatedAt:desc');

        fireEvent.click(screen.getByRole('button', { name: /^name/i }));
        await waitFor(() => {
            const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
            expect(last.searchParams.get('sort')).toBe('name:asc');
        });
    });

    it('navigates to the tenant detail when a row is clicked', async () => {
        stubFetch(() => listResponse(TENANTS));
        renderWithProviders(<TenantsListScreen />);

        fireEvent.click(await screen.findByText('Bayview Health Network'));
        expect(push).toHaveBeenCalledWith('/tenants/t-2');
    });

    it('runs a lifecycle action from the row menu through its confirm dialog', async () => {
        const calls = stubFetch((url, init) => {
            if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/hope/admin/tenants?')) return listResponse(TENANTS);
            if (init?.method === 'POST' && url === '/api/hope/admin/tenants/t-1/suspend') {
                return Response.json(tenant({ resourceStatus: 'SUSPENDED' }));
            }
            return undefined;
        });
        renderWithProviders(<TenantsListScreen />);

        const trigger = await screen.findByRole('button', { name: /open actions for sunrise medical group/i });
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
        fireEvent.click(await screen.findByRole('menuitem', { name: /suspend/i }));

        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /^suspend$/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/t-1/suspend')).toBe(true));
    });

    it('creates a tenant through the wizard and navigates to the new detail page', async () => {
        const calls = stubFetch((url, init) => {
            if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/hope/admin/tenants?')) return listResponse([]);
            if (init?.method === 'POST' && url === '/api/hope/admin/tenants') {
                return Response.json(tenant({ id: 't-new', name: 'Acme Health', key: 'acme' }));
            }
            return undefined;
        });
        renderWithProviders(<TenantsListScreen />);
        await screen.findByText(/no tenants yet/i);

        fireEvent.click(screen.getAllByRole('button', { name: /new tenant/i })[0]);
        const dialog = await screen.findByRole('dialog');

        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Acme Health' } });
        fireEvent.change(within(dialog).getByLabelText(/^key/i), { target: { value: 'acme' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));

        // Step 2 confirms the entered details before submitting.
        expect(within(dialog).getByText('Acme Health')).toBeDefined();
        fireEvent.click(within(dialog).getByRole('button', { name: /create tenant/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants');
            expect(post?.body).toEqual({ name: 'Acme Health', key: 'acme' });
        });
        await waitFor(() => expect(push).toHaveBeenCalledWith('/tenants/t-new'));
    });
});
