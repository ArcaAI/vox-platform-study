/**
 * TASK-497 §3.5 — CreateTenantDialog gains a mandatory 3rd step (tenant
 * admin: existing user vs new local user) and now submits through
 * POST /admin/tenants/provision (useProvisionTenant) instead of the plain
 * create — a tenant is never left adminless from this dialog. The existing
 * user is chosen through the UserPicker combobox (searches GET /admin/users
 * by username), not a free-text userId field.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CreateTenantDialog } from '../create-tenant-dialog';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
    toast: { success: toastSuccess, error: toastError },
}));

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

function goToStep2(dialog: HTMLElement, name = 'Acme Health') {
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: name } });
    fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));
}

function goToStep3(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));
}

const PICKER_USER = { id: 'user-1', username: 'admin.acme', isServiceAccount: false };

/** Answers the UserPicker's username search (GET /admin/users). */
function usersResponse(url: string, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET' || !url.includes('/api/hope/admin/users')) return undefined;
    return Response.json({ data: [PICKER_USER], count: 1, limit: 10, page: 0 });
}

/** Select an existing admin through the UserPicker (popover + command palette portals to body). */
async function pickExistingUser(dialog: HTMLElement, username = PICKER_USER.username) {
    fireEvent.click(within(dialog).getByRole('combobox', { name: /user/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search users by username/i), { target: { value: username } });
    fireEvent.click(await screen.findByText(username));
}

afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
    cleanup();
});

describe('CreateTenantDialog (TASK-497)', () => {
    it('lets step 1 proceed with name alone (key is now optional) and previews a generated key', () => {
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');

        expect(within(dialog).getByRole('button', { name: /next/i })).toHaveProperty('disabled', true);
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Acme Health' } });

        expect(within(dialog).getByRole('button', { name: /next/i })).toHaveProperty('disabled', false);
        expect(within(dialog).getByText('acme-health')).toBeDefined();
    });

    it('defaults the plan to STARTER on step 2', () => {
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        goToStep2(dialog);

        const starterRadio = within(dialog).getByRole('radio', { name: /starter/i }) as HTMLInputElement;
        expect(starterRadio.checked).toBe(true);
    });

    it('defaults the admin step to "existing user" and shows the user picker', () => {
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        goToStep2(dialog);
        goToStep3(dialog);

        expect(within(dialog).getByRole('combobox', { name: /user/i })).toBeDefined();
        expect(within(dialog).queryByLabelText(/^email/i)).toBeNull();
    });

    it('switches to new-local-admin fields (email/username/password) on toggle', () => {
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        goToStep2(dialog);
        goToStep3(dialog);

        fireEvent.click(within(dialog).getByRole('radio', { name: /create a new local user/i }));

        expect(within(dialog).getByLabelText(/^email/i)).toBeDefined();
        expect(within(dialog).getByLabelText(/^password/i)).toBeDefined();
        expect(within(dialog).queryByRole('combobox')).toBeNull();
    });

    it('provisions with an existing admin', async () => {
        const calls = stubFetch((url, init) => {
            const users = usersResponse(url, init);
            if (users) return users;
            if (init?.method === 'POST' && url === '/api/hope/admin/tenants/provision') {
                return Response.json({ tenant: { id: 't-new', name: 'Acme Health', key: 'acme-health' }, adminUserId: 'user-1', tenantKey: 'acme-health' });
            }
            return undefined;
        });
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        goToStep2(dialog);
        goToStep3(dialog);
        await pickExistingUser(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: /create tenant/i }));

        // The picker searched by username against the users list endpoint.
        const search = calls.find((call) => call.method === 'GET' && call.url.includes('/api/hope/admin/users'));
        expect(search?.url).toContain('searchFields=username');

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/provision');
            expect(post?.body).toEqual({
                tenantName: 'Acme Health',
                plan: 'STARTER',
                admin: { mode: 'existing', userId: 'user-1' },
            });
        });
        await waitFor(() => expect(push).toHaveBeenCalledWith('/tenants/t-new'));
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('provisions with a new local admin', async () => {
        const calls = stubFetch((url, init) => {
            if (init?.method === 'POST' && url === '/api/hope/admin/tenants/provision') {
                return Response.json({ tenant: { id: 't-new', name: 'Acme Health', key: 'acme-health' }, adminUserId: 'user-2', tenantKey: 'acme-health' });
            }
            return undefined;
        });
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        goToStep2(dialog);
        goToStep3(dialog);
        fireEvent.click(within(dialog).getByRole('radio', { name: /create a new local user/i }));
        fireEvent.change(within(dialog).getByLabelText(/^email/i), { target: { value: 'admin@acme.test' } });
        fireEvent.change(within(dialog).getByLabelText(/^password/i), { target: { value: 'S3cret!Pass' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /create tenant/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/provision');
            expect(post?.body).toEqual({
                tenantName: 'Acme Health',
                plan: 'STARTER',
                admin: { mode: 'new-local', email: 'admin@acme.test', password: 'S3cret!Pass' },
            });
        });
    });

    it('includes an explicit key when the caller overrides the preview', async () => {
        const calls = stubFetch((url, init) => {
            const users = usersResponse(url, init);
            if (users) return users;
            if (init?.method === 'POST' && url === '/api/hope/admin/tenants/provision') {
                return Response.json({ tenant: { id: 't-new' }, adminUserId: 'user-1', tenantKey: 'custom-key' });
            }
            return undefined;
        });
        renderWithProviders(<CreateTenantDialog open onOpenChange={() => {}} />);
        const dialog = screen.getByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Acme Health' } });
        fireEvent.change(within(dialog).getByLabelText(/^key/i), { target: { value: 'custom-key' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));
        goToStep3(dialog);
        await pickExistingUser(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: /create tenant/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/provision');
            expect(post?.body).toEqual(expect.objectContaining({ tenantKey: 'custom-key' }));
        });
    });
});
