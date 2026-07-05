/**
 * TDD screen tests for frame 22 (RBAC Policies): list states, the JSON rules
 * editor with its validate preflight (client parse -> POST /validate -> save
 * gate), the break-glass flows (delete; 428 on multi-role rule edits retried
 * with body.breakGlass) and the OCC 412 alert.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Policy, RbacPaginated } from '../../api/types';
import { PoliciesScreen } from '../policies-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function policy(overrides: Partial<Policy> = {}): Policy {
    return {
        id: 'p-1',
        name: 'tenant.manage',
        description: 'Full tenant lifecycle',
        scope: 'TENANT',
        rules: [
            { action: 'create', subject: 'Tenant' },
            { action: 'update', subject: 'Tenant' },
        ],
        resourceStatus: 'ENABLED',
        isProtected: false,
        createdAt: '2026-01-05T08:00:00.000Z',
        updatedAt: '2026-06-21T08:00:00.000Z',
        ...overrides,
    };
}

const TENANT_POLICY = policy();
const PROTECTED_POLICY = policy({ id: 'p-2', name: 'platform.super-admin', scope: 'GLOBAL', isProtected: true });

function envelope(rows: Policy[]): RbacPaginated<Policy> {
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

async function openEditSheet(name: string) {
    openRowMenu(name);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    return await screen.findByRole('dialog');
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('PoliciesScreen', () => {
    it('renders the loaded policies with scope, rules count, status and updated cells', async () => {
        stubFetch(() => Response.json(envelope([TENANT_POLICY, PROTECTED_POLICY])));
        renderWithProviders(<PoliciesScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Policies' })).toBeDefined();
        expect(await screen.findByText('tenant.manage')).toBeDefined();
        expect(screen.getByText('platform.super-admin')).toBeDefined();
        expect(screen.getByText('Tenant')).toBeDefined();
        expect(screen.getByText('Global')).toBeDefined();
        expect(screen.getByText('Protected')).toBeDefined();
        expect(screen.getByRole('table', { name: 'Policies' })).toBeDefined();
    });

    it('maps search/scope/page URL state onto the gateway list request', async () => {
        const calls = stubFetch(() => Response.json(envelope([TENANT_POLICY])));
        renderWithProviders(<PoliciesScreen />, { searchParams: '?search=tenant&scope=TENANT&page=1' });

        await screen.findByText('tenant.manage');
        const requested = new URL(calls[0].url, 'http://test.local');
        expect(requested.pathname).toBe('/api/hope/admin/rbac/policies');
        expect(requested.searchParams.get('search')).toBe('tenant');
        expect(requested.searchParams.get('scope')).toBe('TENANT');
        expect(requested.searchParams.get('page')).toBe('2');
    });

    it('shows the neutral empty state when no policies match', async () => {
        stubFetch(() => Response.json(envelope([])));
        renderWithProviders(<PoliciesScreen />);

        expect(await screen.findByText('No policies match')).toBeDefined();
    });

    it('surfaces a block error with retry when the list request fails', async () => {
        stubFetch(() => Response.json({ message: 'RBAC API unreachable' }, { status: 503 }));
        renderWithProviders(<PoliciesScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('RBAC API unreachable')).toBeDefined();
        expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    });

    it('blocks save and shows an inline parse error for invalid JSON rules', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'GET') return Response.json(envelope([]));
            return undefined;
        });
        renderWithProviders(<PoliciesScreen />);
        await screen.findByText('No policies match');

        fireEvent.click(screen.getAllByRole('button', { name: 'New policy' })[0]);
        const sheet = await screen.findByRole('dialog');
        fireEvent.change(within(sheet).getByLabelText(/^name/i), { target: { value: 'audit.read' } });
        fireEvent.change(within(sheet).getByLabelText(/rules \(json\)/i), { target: { value: '[{ "action": ' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Validate' }));

        expect(await within(sheet).findByText('Invalid JSON')).toBeDefined();
        expect((within(sheet).getByRole('button', { name: 'Create policy' }) as HTMLButtonElement).disabled).toBe(true);
        // The parse preflight fails client-side; the validate endpoint is never hit.
        expect(calls.some((call) => call.url.endsWith('/validate'))).toBe(false);
    });

    it('renders gateway validation errors and keeps save disabled', async () => {
        stubFetch((url, method) => {
            if (method === 'POST' && url === '/api/hope/admin/rbac/policies/validate') {
                return Response.json({ valid: false, errors: ['Unknown action "frobnicate"'], warnings: ['Subject "Gadget" is not registered'] });
            }
            if (method === 'GET') return Response.json(envelope([]));
            return undefined;
        });
        renderWithProviders(<PoliciesScreen />);
        await screen.findByText('No policies match');

        fireEvent.click(screen.getAllByRole('button', { name: 'New policy' })[0]);
        const sheet = await screen.findByRole('dialog');
        fireEvent.change(within(sheet).getByLabelText(/^name/i), { target: { value: 'gadget.frobnicate' } });
        fireEvent.change(within(sheet).getByLabelText(/rules \(json\)/i), {
            target: { value: '[{"action":"frobnicate","subject":"Gadget"}]' },
        });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Validate' }));

        expect(await within(sheet).findByText('Unknown action "frobnicate"')).toBeDefined();
        expect(within(sheet).getByText('Subject "Gadget" is not registered')).toBeDefined();
        expect((within(sheet).getByRole('button', { name: 'Create policy' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables save after a passing validation and POSTs the parsed rules', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST' && url === '/api/hope/admin/rbac/policies/validate') {
                return Response.json({ valid: true });
            }
            if (method === 'POST' && url === '/api/hope/admin/rbac/policies') {
                return Response.json(policy({ id: 'p-9', name: 'audit.read' }));
            }
            if (method === 'GET') return Response.json(envelope([]));
            return undefined;
        });
        renderWithProviders(<PoliciesScreen />);
        await screen.findByText('No policies match');

        fireEvent.click(screen.getAllByRole('button', { name: 'New policy' })[0]);
        const sheet = await screen.findByRole('dialog');
        fireEvent.change(within(sheet).getByLabelText(/^name/i), { target: { value: 'audit.read' } });
        fireEvent.change(within(sheet).getByLabelText(/description/i), { target: { value: 'Read audit logs' } });
        fireEvent.change(within(sheet).getByLabelText(/rules \(json\)/i), {
            target: { value: '[{"action":"read","subject":"AuditLog"}]' },
        });

        const save = within(sheet).getByRole('button', { name: 'Create policy' }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Validate' }));
        expect(await within(sheet).findByText('Rules are valid')).toBeDefined();
        await waitFor(() => expect(save.disabled).toBe(false));
        fireEvent.click(save);

        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/rbac/policies')).toBe(true));
        const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/rbac/policies');
        expect(post?.body).toEqual({
            name: 'audit.read',
            description: 'Read audit logs',
            scope: 'TENANT',
            rules: [{ action: 'read', subject: 'AuditLog' }],
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('requires a fresh validation after the rules text changes again', async () => {
        stubFetch((url, method) => {
            if (method === 'POST' && url === '/api/hope/admin/rbac/policies/validate') return Response.json({ valid: true });
            if (method === 'GET') return Response.json(envelope([]));
            return undefined;
        });
        renderWithProviders(<PoliciesScreen />);
        await screen.findByText('No policies match');

        fireEvent.click(screen.getAllByRole('button', { name: 'New policy' })[0]);
        const sheet = await screen.findByRole('dialog');
        fireEvent.change(within(sheet).getByLabelText(/^name/i), { target: { value: 'audit.read' } });
        const editor = within(sheet).getByLabelText(/rules \(json\)/i);
        fireEvent.change(editor, { target: { value: '[{"action":"read","subject":"AuditLog"}]' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Validate' }));

        const save = within(sheet).getByRole('button', { name: 'Create policy' }) as HTMLButtonElement;
        await waitFor(() => expect(save.disabled).toBe(false));

        // Editing invalidates the previous validation result.
        fireEvent.change(editor, { target: { value: '[{"action":"manage","subject":"AuditLog"}]' } });
        await waitFor(() => expect(save.disabled).toBe(true));
    });

    it('deletes a policy only after break-glass credentials and sends them in the DELETE body', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'DELETE') return new Response(null, { status: 204 });
            return Response.json(envelope([TENANT_POLICY]));
        });
        renderWithProviders(<PoliciesScreen />);

        await screen.findByText('tenant.manage');
        openRowMenu('tenant.manage');
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'hunter2' } });
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'tenant.manage' } });
        fireEvent.click(screen.getByRole('button', { name: 'Delete policy' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.url).toBe('/api/hope/admin/rbac/policies/p-1');
        expect(del?.body).toEqual({ password: 'hunter2', confirmationName: 'tenant.manage' });
    });

    it('disables delete for protected system policies', async () => {
        stubFetch(() => Response.json(envelope([PROTECTED_POLICY])));
        renderWithProviders(<PoliciesScreen />);

        await screen.findByText('platform.super-admin');
        openRowMenu('platform.super-admin');
        const item = await screen.findByRole('menuitem', { name: 'Delete' });
        expect(item.getAttribute('aria-disabled')).toBe('true');
    });

    it('shows the OCC conflict alert when an edit PATCH returns 412', async () => {
        stubFetch((url, method) => {
            if (method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
            if (url === '/api/hope/admin/rbac/policies/p-1') return Response.json(TENANT_POLICY);
            return Response.json(envelope([TENANT_POLICY]));
        });
        renderWithProviders(<PoliciesScreen />);

        await screen.findByText('tenant.manage');
        const sheet = await openEditSheet('tenant.manage');
        await within(sheet).findByDisplayValue('tenant.manage');
        fireEvent.change(within(sheet).getByLabelText(/^name/i), { target: { value: 'tenant.manage.v2' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    });

    it('retries a multi-role rule edit with break-glass credentials after a 428', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST' && url === '/api/hope/admin/rbac/policies/validate') return Response.json({ valid: true });
            if (method === 'PATCH') {
                const body = calls.at(-1)?.body as { breakGlass?: unknown };
                return body.breakGlass
                    ? Response.json(TENANT_POLICY)
                    : Response.json({ message: 'Break-glass confirmation required' }, { status: 428 });
            }
            if (url === '/api/hope/admin/rbac/policies/p-1') return Response.json(TENANT_POLICY);
            return Response.json(envelope([TENANT_POLICY]));
        });
        renderWithProviders(<PoliciesScreen />);

        await screen.findByText('tenant.manage');
        const sheet = await openEditSheet('tenant.manage');
        await within(sheet).findByDisplayValue('tenant.manage');
        fireEvent.change(within(sheet).getByLabelText(/rules \(json\)/i), {
            target: { value: '[{"action":"manage","subject":"Tenant"}]' },
        });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Validate' }));
        const save = within(sheet).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
        await waitFor(() => expect(save.disabled).toBe(false));
        fireEvent.click(save);

        // 428 -> the break-glass dialog opens; confirming retries with body.breakGlass.
        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'hunter2' } });
        fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'tenant.manage' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save with break-glass' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2));
        const retried = calls.filter((call) => call.method === 'PATCH').at(-1);
        expect(retried?.url).toBe('/api/hope/admin/rbac/policies/p-1');
        expect(retried?.body).toMatchObject({
            rules: [{ action: 'manage', subject: 'Tenant' }],
            breakGlass: { password: 'hunter2', confirmationName: 'tenant.manage' },
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
});
