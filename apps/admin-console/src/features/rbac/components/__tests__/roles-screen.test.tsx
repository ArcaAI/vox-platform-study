/**
 * TDD screen tests for frame 21 (RBAC Roles): list states, the one-based
 * page/pageSize wire mapping, the role detail sheet with policy detach, and
 * the break-glass delete flow (DELETE body carries password +
 * confirmationName = the ROLE name; detach confirms the POLICY name).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { RbacPaginated, Role } from '../../api/types';
import { RolesScreen } from '../roles-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function role(overrides: Partial<Role> = {}): Role {
    return {
        id: 'r-1',
        name: 'GlobalAdmin',
        description: 'Full platform access',
        isSystemRole: true,
        resourceStatus: 'ENABLED',
        createdAt: '2026-01-05T08:00:00.000Z',
        updatedAt: '2026-06-21T08:00:00.000Z',
        policies: [
            { id: 'p-1', name: 'tenant.manage', priority: 10 },
            { id: 'p-2', name: 'tenant.read', priority: 20 },
        ],
        ...overrides,
    };
}

const SYSTEM_ROLE = role();
const CUSTOM_ROLE = role({
    id: 'r-2',
    name: 'Billing',
    description: 'Billing operators',
    isSystemRole: false,
    policies: [{ id: 'p-1', name: 'tenant.manage', priority: 10 }],
});

function envelope(rows: Role[]): RbacPaginated<Role> {
    return { data: rows, total: rows.length, page: 1, pageSize: 25 };
}

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function stubFetch(handler: (url: string, method: string) => Response | undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
            const response = handler(url, method);
            if (!response) throw new Error(`Unhandled fetch: ${method} ${url}`);
            return response;
        }),
    );
    return calls;
}

function openRowMenu(name: string) {
    const trigger = screen.getByRole('button', { name: `Open actions for ${name}` });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('RolesScreen', () => {
    it('renders the loaded roles with type, policies count, status and updated cells', async () => {
        stubFetch(() => Response.json(envelope([SYSTEM_ROLE, CUSTOM_ROLE])));
        renderWithProviders(<RolesScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Roles' })).toBeDefined();
        expect(await screen.findByText('GlobalAdmin')).toBeDefined();
        expect(screen.getByText('Billing')).toBeDefined();
        expect(screen.getByText('System (locked)')).toBeDefined();
        expect(screen.getByText('Custom')).toBeDefined();
        expect(screen.getByRole('table', { name: 'Roles' })).toBeDefined();
    });

    it('maps the zero-based URL page onto the one-based gateway request', async () => {
        const calls = stubFetch(() => Response.json(envelope([CUSTOM_ROLE])));
        renderWithProviders(<RolesScreen />, { searchParams: '?search=admin&page=1&limit=50' });

        await screen.findByText('Billing');
        const requested = new URL(calls[0].url, 'http://test.local');
        expect(requested.pathname).toBe('/api/hope/admin/rbac/roles');
        expect(requested.searchParams.get('page')).toBe('2');
        expect(requested.searchParams.get('pageSize')).toBe('50');
        expect(requested.searchParams.get('search')).toBe('admin');
    });

    it('shows the neutral empty state with a create CTA when no roles load', async () => {
        stubFetch(() => Response.json(envelope([])));
        renderWithProviders(<RolesScreen />);

        expect(await screen.findByText('No custom roles yet')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'New role' }).length).toBeGreaterThanOrEqual(2);
    });

    it('surfaces a block error with retry and refetches the list', async () => {
        let attempts = 0;
        stubFetch(() => {
            attempts += 1;
            return attempts === 1
                ? Response.json({ message: 'RBAC API unreachable' }, { status: 503 })
                : Response.json(envelope([CUSTOM_ROLE]));
        });
        renderWithProviders(<RolesScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('RBAC API unreachable')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByText('Billing')).toBeDefined();
    });

    it('deletes a role only after break-glass credentials and sends them in the DELETE body', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'DELETE') return new Response(null, { status: 204 });
            return Response.json(envelope([CUSTOM_ROLE]));
        });
        renderWithProviders(<RolesScreen />);

        await screen.findByText('Billing');
        openRowMenu('Billing');
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

        // The break-glass dialog collects the password + exact role name.
        const password = await screen.findByLabelText('Your password');
        const confirm = screen.getByRole('button', { name: 'Delete role' }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

        fireEvent.change(password, { target: { value: 'hunter2' } });
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'Billing' } });
        await waitFor(() => expect(confirm.disabled).toBe(false));
        fireEvent.click(confirm);

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.url).toBe('/api/hope/admin/rbac/roles/r-2');
        expect(del?.body).toEqual({ password: 'hunter2', confirmationName: 'Billing' });
    });

    it('locks system roles: the delete action is disabled in the row menu', async () => {
        stubFetch(() => Response.json(envelope([SYSTEM_ROLE])));
        renderWithProviders(<RolesScreen />);

        await screen.findByText('GlobalAdmin');
        openRowMenu('GlobalAdmin');
        const item = await screen.findByRole('menuitem', { name: 'Delete' });
        expect(item.getAttribute('aria-disabled')).toBe('true');
    });

    it('opens the role detail on row click and detaches a policy with the POLICY name as confirmation', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'DELETE') return new Response(null, { status: 204 });
            if (url === '/api/hope/admin/rbac/roles/r-2') return Response.json(CUSTOM_ROLE);
            if (url.startsWith('/api/hope/admin/rbac/policies')) return Response.json({ data: [], total: 0, page: 1, pageSize: 100 });
            return Response.json(envelope([CUSTOM_ROLE]));
        });
        renderWithProviders(<RolesScreen />);

        fireEvent.click(await screen.findByText('Billing'));
        expect(await screen.findByText('tenant.manage')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Detach tenant.manage' }));
        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'hunter2' } });
        // The gateway matches the POLICY name (the object being detached).
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'tenant.manage' } });
        fireEvent.click(screen.getByRole('button', { name: 'Detach policy' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.url).toBe('/api/hope/admin/rbac/roles/r-2/policies/p-1');
        expect(del?.body).toEqual({ password: 'hunter2', confirmationName: 'tenant.manage' });
    });

    it('creates a role by POSTing the dialog payload', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST') return Response.json(role({ id: 'r-9', name: 'Auditor', isSystemRole: false }));
            return Response.json(envelope([]));
        });
        renderWithProviders(<RolesScreen />);
        await screen.findByText('No custom roles yet');

        fireEvent.click(screen.getAllByRole('button', { name: 'New role' })[0]);
        fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: 'Auditor' } });
        fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Read-only reviewers' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create role' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toBe('/api/hope/admin/rbac/roles');
        expect(post?.body).toEqual({ name: 'Auditor', description: 'Read-only reviewers' });
    });
});
