/**
 * TDD screen tests for frame 24 (Settings & secrets): list states, the
 * permission-gated step-up reveal flow, OCC If-Match editing (412 alert) and
 * create/delete flows — against a URL-branching fetch stub covering the BFF
 * session + permission routes. Scope is set by the working-tenant switcher (no
 * in-page scope tabs), so this list always reads `GET /admin/settings`.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { GlobalSetting } from '../../api/types';
import { SettingsScreen } from '../settings-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function setting(overrides: Partial<GlobalSetting> = {}): GlobalSetting {
    return {
        id: 's-1',
        projectId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        resourceStatus: 'ENABLED',
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        createdBy: null,
        updatedBy: null,
        name: 'SMTP relay host',
        description: 'Outbound mail relay',
        key: 'smtp.host',
        value: 'mail.local',
        dataType: 'String',
        namespace: 'smtp',
        locked: false,
        version: 2,
        isSecret: false,
        ...overrides,
    };
}

// Secret rows serialize with an empty value — only the mask is rendered.
const SECRET = setting({ id: 's-2', name: 'SMTP password', key: 'smtp.password', value: '', version: 4, isSecret: true });
const SETTINGS = [setting(), SECRET];

const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: null as string | null,
    workingTenantName: null as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
};

const MANAGE_ALL = [{ action: 'manage', subject: 'all' }];
const READ_ONLY = [{ action: 'read', subject: 'GlobalSetting' }];

function envelope(rows: GlobalSetting[]) {
    return { data: rows, count: rows.length, limit: 25, page: 0 };
}

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

interface StubOptions {
    rows?: GlobalSetting[];
    permissions?: { action: string; subject: string }[];
    session?: typeof SESSION;
    custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ rows = SETTINGS, permissions = MANAGE_ALL, session = SESSION, custom }: StubOptions = {}): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const handled = custom?.(call);
            if (handled) return handled;
            // The grid persists per-user layout via `user/me/settings` — no saved layout in tests.
            if (call.url.includes('/user/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
            if (call.url === '/api/auth/session') return Response.json(session);
            if (call.url === '/api/hope/rbac/check/my-permissions') {
                return Response.json({ userId: 'u-1', tenantId: null, permissions });
            }
            if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/settings?')) return Response.json(envelope(rows));
            throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('SettingsScreen', () => {
    it('renders settings with masked secrets, inline values, namespace and type', async () => {
        stubFetch();
        renderWithProviders(<SettingsScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Settings & secrets' })).toBeDefined();
        expect(await screen.findByText('smtp.host')).toBeDefined();
        expect(screen.getByText('mail.local')).toBeDefined();
        // The secret row never renders a value — only the mask.
        expect(screen.getByText('smtp.password')).toBeDefined();
        expect(screen.getByText('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022')).toBeDefined();
        expect(screen.getAllByText('String').length).toBeGreaterThan(0);
        expect(screen.getAllByText('smtp').length).toBeGreaterThan(0);
        expect(screen.getByRole('grid', { name: 'Settings' })).toBeDefined();
        expect(screen.getByText(/2 settings/)).toBeDefined();
    });

    it('mirrors the loaded layout with skeletons while the list is in flight', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => {})),
        );
        const { container } = renderWithProviders(<SettingsScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByText('smtp.host')).toBeNull();
    });

    it('shows the neutral empty state when no settings exist', async () => {
        stubFetch({ rows: [] });
        renderWithProviders(<SettingsScreen />);

        expect(await screen.findByText('No settings yet')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'New setting' }).length).toBeGreaterThanOrEqual(2);
    });

    it('surfaces a block error with retry and refetches the list', async () => {
        let attempts = 0;
        stubFetch({
            custom: (call) => {
                if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/settings?')) {
                    attempts += 1;
                    if (attempts === 1) return Response.json({ message: 'Vault sealed' }, { status: 503 });
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('Vault sealed')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByText('smtp.host')).toBeDefined();
    });

    // TASK-430 — cross-tenant admin surface: Tenant column + tenant filter.
    it('renders the Tenant column with the catalog name and a dash for rows without a tenant', async () => {
        stubFetch({
            rows: [setting({ tenantId: 't-1' }), setting({ id: 's-9', name: 'Retention days', key: 'retention.days', tenantId: null })],
            custom: (call) => {
                if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/tenants')) {
                    return Response.json({ data: [{ id: 't-1', name: 'Acme Hospital', key: 'acme' }], count: 1, limit: 500, page: 0 });
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);

        await screen.findByText('smtp.host');
        expect(await screen.findByText('Acme Hospital')).toBeDefined();
    });

    it('maps the tenant filter onto the CSV grammar (tenantId[equals]:…)', async () => {
        const calls = stubFetch();
        const f = encodeURIComponent(JSON.stringify([['tenantId', 'eq', 'select', 't-1']]));
        renderWithProviders(<SettingsScreen />, { searchParams: `?f=${f}` });

        await screen.findByText('smtp.host');
        const list = calls.find((call) => call.url.startsWith('/api/hope/admin/settings?'));
        const requested = new URL(list?.url ?? '', 'http://test.local');
        expect(requested.searchParams.get('filters')).toBe('tenantId[equals]:t-1');
    });

    it('hides the reveal action without the manage/all permission', async () => {
        stubFetch({ permissions: READ_ONLY });
        renderWithProviders(<SettingsScreen />);

        await screen.findByText('smtp.password');
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Reveal smtp.password' })).toBeNull());
    });

    it('reveals a secret after the step-up password confirm and hides it again', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'POST' && call.url === '/api/hope/admin/settings/s-2/reveal') {
                    return Response.json({ id: 's-2', key: 'smtp.password', value: 'hunter2-plaintext', revealedAt: '2026-07-05T00:00:00.000Z' });
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.password');

        fireEvent.click(await screen.findByRole('button', { name: 'Reveal smtp.password' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/password/i), { target: { value: 'p@ss' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal secret' }));

        // Step-up POST carries the re-entered password.
        await waitFor(() => expect(calls.some((call) => call.url === '/api/hope/admin/settings/s-2/reveal')).toBe(true));
        expect(calls.find((call) => call.url.endsWith('/reveal'))?.body).toEqual({ password: 'p@ss' });

        // The revealed value swaps in with copy + hide controls.
        expect(await screen.findByText('hunter2-plaintext')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Copy smtp.password' })).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Hide smtp.password' }));
        expect(screen.queryByText('hunter2-plaintext')).toBeNull();
        expect(screen.getAllByText('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022').length).toBeGreaterThan(0);
    });

    it('saves a value edit with If-Match and expectedVersion from the read ETag', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'PATCH' && call.url === '/api/hope/admin/settings/s-1') {
                    return Response.json(setting({ value: 'mail2.local', version: 3 }), { headers: { etag: '"3"' } });
                }
                if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-1') {
                    return Response.json(setting(), { headers: { etag: '"2"' } });
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        fireEvent.click(screen.getByRole('button', { name: 'Edit smtp.host' }));
        const dialog = await screen.findByRole('dialog');
        const valueInput = await within(dialog).findByLabelText(/^value/i);
        fireEvent.change(valueInput, { target: { value: 'mail2.local' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.url).toBe('/api/hope/admin/settings/s-1');
        expect(patch?.headers.get('if-match')).toBe('"2"');
        expect(patch?.body).toEqual({ value: 'mail2.local', expectedVersion: 2 });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('shows the OCC conflict alert when the PATCH returns 412', async () => {
        stubFetch({
            custom: (call) => {
                if (call.method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
                if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-1') {
                    return Response.json(setting(), { headers: { etag: '"2"' } });
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        fireEvent.click(screen.getByRole('button', { name: 'Edit smtp.host' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(await within(dialog).findByLabelText(/^value/i), { target: { value: 'mail2.local' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
        // The dialog stays open so local edits are not lost.
        expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('creates a setting from the create dialog payload', async () => {
        const calls = stubFetch({
            rows: [],
            custom: (call) => {
                if (call.method === 'POST' && call.url === '/api/hope/admin/settings') {
                    return Response.json(setting({ id: 's-new', key: 'features.harness' }));
                }
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('No settings yet');

        fireEvent.click(screen.getAllByRole('button', { name: 'New setting' })[0]);
        const dialog = await screen.findByRole('dialog');
        // \b keeps "Name" from also matching the "Namespace" label.
        fireEvent.change(within(dialog).getByLabelText(/^name\b/i), { target: { value: 'Harness rollout' } });
        fireEvent.change(within(dialog).getByLabelText(/^key/i), { target: { value: 'features.harness' } });
        fireEvent.change(within(dialog).getByLabelText(/^value/i), { target: { value: 'on' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create setting' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/settings')).toBe(true));
        const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/settings');
        expect(post?.body).toEqual({ name: 'Harness rollout', key: 'features.harness', value: 'on', dataType: 'String' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('deletes a setting after the destructive confirm', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'DELETE') return Response.json(setting());
                return undefined;
            },
        });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        fireEvent.click(screen.getByRole('button', { name: 'Delete smtp.host' }));
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

        const confirm = await screen.findByRole('alertdialog');
        fireEvent.click(within(confirm).getByRole('button', { name: 'Delete setting' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
        expect(calls.find((call) => call.method === 'DELETE')?.url).toBe('/api/hope/admin/settings/s-1');
    });
});
