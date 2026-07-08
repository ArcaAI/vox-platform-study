/**
 * TDD screen tests for the TASK-438 two-pane RBAC Roles redesign (frame 21):
 * grouped role list, selection → detail with the derived permission matrix,
 * system-role lockdown, tab switching (Permissions/Members/Policies), the
 * screen-level break-glass delete, policy detach, the 412 OCC alert, and the
 * mobile drawer + matrix-card fallback.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Policy, RbacPaginated, Role } from '../../api/types';
import { RolesScreen } from '../roles-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Viewport tier drives desktop two-pane vs the compact DetailDrawer; make it deterministic.
let currentTier: 'desktop' | 'tablet' | 'mobile' = 'desktop';
vi.mock('@/shared/layout/use-viewport-tier', () => ({
    useViewportTier: () => currentTier,
    TABLET_MIN_PX: 768,
    DESKTOP_MIN_PX: 1280,
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
        policies: [{ id: 'p-1', name: 'tenant.manage', priority: 10 }],
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

const POLICY_CATALOG: Policy[] = [
    {
        id: 'p-1',
        name: 'tenant.manage',
        scope: 'TENANT',
        rules: [{ action: 'manage', subject: 'Tenant' }],
        resourceStatus: 'ENABLED',
        isProtected: false,
        createdAt: '2026-01-05T08:00:00.000Z',
        updatedAt: '2026-01-05T08:00:00.000Z',
    },
];

function envelope(rows: Role[]): RbacPaginated<Role> {
    return { data: rows, total: rows.length, page: 1, pageSize: 100 };
}

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

/** Default handler covering the list, the two roles, the policy catalog and DELETEs. */
function defaultHandler(url: string, method: string): Response | undefined {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (url === '/api/hope/admin/rbac/roles/r-2') return Response.json(CUSTOM_ROLE);
    if (url === '/api/hope/admin/rbac/roles/r-1') return Response.json(SYSTEM_ROLE);
    if (url.startsWith('/api/hope/admin/rbac/policies')) return Response.json({ data: POLICY_CATALOG, total: 1, page: 1, pageSize: 100 });
    if (url.includes('/admin/rbac/roles')) return Response.json(envelope([SYSTEM_ROLE, CUSTOM_ROLE]));
    return undefined;
}

function stubFetch(handler: (url: string, method: string) => Response | undefined = defaultHandler): RecordedCall[] {
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

beforeEach(() => {
    currentTier = 'desktop';
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('RolesScreen (two-pane redesign)', () => {
    it('renders the grouped role list (System · locked / Custom)', async () => {
        stubFetch();
        renderWithProviders(<RolesScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Roles' })).toBeDefined();
        expect(await screen.findByRole('button', { name: 'GlobalAdmin' })).toBeDefined();
        expect(screen.getByRole('button', { name: 'Billing' })).toBeDefined();
        expect(screen.getByText(/System · locked/i)).toBeDefined();
        expect(screen.getByText(/^Custom/i)).toBeDefined();
        // No role selected yet — the right pane invites a selection.
        expect(screen.getByText('Select a role')).toBeDefined();
    });

    it('selects a role and renders its derived permission matrix', async () => {
        stubFetch();
        renderWithProviders(<RolesScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Billing' }));

        // Detail header + matrix table with the manage-expanded Tenant row.
        expect(await screen.findByRole('heading', { level: 2, name: 'Billing' })).toBeDefined();
        const table = await screen.findByRole('table');
        expect(within(table).getByRole('rowheader', { name: 'Tenant settings' })).toBeDefined();
        expect(within(table).getAllByText('Granted').length).toBeGreaterThanOrEqual(1);
    });

    it('locks system roles: no Edit/Delete, Policies tab shows the lock notice and no attach', async () => {
        stubFetch();
        // Land directly on the system role's Policies tab (Radix tab activation
        // is URL-driven here — see role-detail useRoleTab).
        renderWithProviders(<RolesScreen />, { searchParams: '?role=r-1&tab=policies' });

        await screen.findByRole('heading', { level: 2, name: 'GlobalAdmin' });
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
        // Lock notice appears in both the header and the Policies panel.
        expect((await screen.findAllByText(/System role — seed-managed and read-only/i)).length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByRole('button', { name: 'Attach policy' })).toBeNull();
    });

    it('deletes a role through the screen-level break-glass step-up', async () => {
        const calls = stubFetch();
        renderWithProviders(<RolesScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Billing' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

        const password = await screen.findByLabelText('Your password');
        const confirm = screen.getByRole('button', { name: 'Delete role' }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.change(password, { target: { value: 'hunter2' } });
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'Billing' } });
        await waitFor(() => expect(confirm.disabled).toBe(false));
        fireEvent.click(confirm);

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.url).toBe('/api/hope/admin/rbac/roles/r-2');
        expect(del?.body).toEqual({ password: 'hunter2', confirmationName: 'Billing' });
    });

    it('detaches a policy from the Policies tab with the POLICY name as confirmation', async () => {
        const calls = stubFetch();
        renderWithProviders(<RolesScreen />, { searchParams: '?role=r-2&tab=policies' });

        fireEvent.click(await screen.findByRole('button', { name: 'Detach tenant.manage' }));
        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'hunter2' } });
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'tenant.manage' } });
        fireEvent.click(screen.getByRole('button', { name: 'Detach policy' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.url).toBe('/api/hope/admin/rbac/roles/r-2/policies/p-1');
        expect(del?.body).toEqual({ password: 'hunter2', confirmationName: 'tenant.manage' });
    });

    it('shows the OCC alert and preserves edits on a 412', async () => {
        stubFetch((url, method) => {
            if (method === 'PATCH') return Response.json({ message: 'changed by another admin' }, { status: 412 });
            return defaultHandler(url, method);
        });
        renderWithProviders(<RolesScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Billing' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

        const nameInput = (await screen.findByLabelText(/^name/i)) as HTMLInputElement;
        fireEvent.change(nameInput, { target: { value: 'Billing Ops' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/412 Precondition Failed/i)).toBeDefined();
        // The user's edit is preserved after the conflict.
        expect(nameInput.value).toBe('Billing Ops');
    });

    it('creates a role by POSTing the dialog payload', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST') return Response.json(role({ id: 'r-9', name: 'Auditor', isSystemRole: false, policies: [] }));
            return defaultHandler(url, method);
        });
        renderWithProviders(<RolesScreen />);
        await screen.findByRole('button', { name: 'Billing' });

        fireEvent.click(screen.getByRole('button', { name: 'New role' }));
        fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: 'Auditor' } });
        fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Read-only reviewers' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create role' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toBe('/api/hope/admin/rbac/roles');
        expect(post?.body).toEqual({ name: 'Auditor', description: 'Read-only reviewers' });
    });

    it('mobile tier: opens the detail in a drawer with the matrix card fallback', async () => {
        currentTier = 'mobile';
        stubFetch();
        renderWithProviders(<RolesScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Billing' }));
        // The drawer detail renders; matrix is cards (no <table>) on mobile.
        await screen.findByText('Tenant settings');
        expect(screen.queryByRole('table')).toBeNull();
        expect(screen.getByRole('list', { name: 'Permissions by resource' })).toBeDefined();
    });
});
