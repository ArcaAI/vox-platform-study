/**
 * TDD screen tests for frame 24 (Settings & secrets): list states, the
 * cross-tenant Tenant column/filter (TASK-430), and the row → DetailDrawer wiring
 * (TASK-439) that replaced the per-row edit/create modals. Value editing, secret
 * reveal/rotate, OCC and the create payload are covered in setting-drawer.test.
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

// Secret rows serialize with an empty value — only the mask is rendered in the list.
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
            // Detail read for the drawer (fresh ETag).
            if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-1') return Response.json(setting(), { headers: { etag: '"2"' } });
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
        expect(screen.getByText('••••••••')).toBeDefined();
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

    // TASK-443 — namespace grouping + Namespace/Type/Secrets-only filter chips.
    it('renders namespace group-header rows with counts between contiguous groups', async () => {
        stubFetch({ rows: [setting(), SECRET, setting({ id: 's-3', name: 'LLM model', key: 'llm.model', namespace: 'llm' })] });
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        const groups = document.querySelectorAll('[data-slot="data-grid-group-row"]');
        expect(groups).toHaveLength(2);
        expect(groups[0].textContent).toContain('smtp');
        expect(groups[0].textContent).toContain('2');
        expect(groups[1].textContent).toContain('llm');
        expect(groups[1].textContent).toContain('1');
    });

    it('sorts by namespace first (implicit sort) so groups are contiguous per page', async () => {
        const calls = stubFetch();
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        const list = calls.map((call) => new URL(call.url, 'http://test.local')).find((url) => url.pathname === '/api/hope/admin/settings' && url.searchParams.get('sort'));
        expect(list?.searchParams.get('sort')).toBe('namespace:asc,key:asc');
    });

    it('offers Namespace, Type and Secrets-only filter controls on the grid toolbar', async () => {
        stubFetch();
        renderWithProviders(<SettingsScreen />);
        await screen.findByText('smtp.host');

        // At the test container width the toolbar collapses the chips into the
        // Filters control; its panel lists one section per filterable column.
        fireEvent.click(screen.getByRole('button', { name: /filters/i }));
        const dialog = await screen.findByRole('dialog');
        for (const label of ['Namespace', 'Type', 'Secrets', 'Tenant']) {
            expect(within(dialog).getByText(label)).toBeDefined();
        }
    });

    it('maps the Namespace chip onto namespace[in] (server-driven)', async () => {
        const calls = stubFetch();
        const f = encodeURIComponent(JSON.stringify([['namespace', 'inArray', 'multiSelect', ['smtp', 'llm']]]));
        renderWithProviders(<SettingsScreen />, { searchParams: `?f=${f}` });
        await screen.findByText('smtp.host');

        const list = calls.map((call) => new URL(call.url, 'http://test.local')).find((url) => url.pathname === '/api/hope/admin/settings' && url.searchParams.get('filters'));
        expect(list?.searchParams.get('filters')).toBe('namespace[in]:smtp|llm');
    });

    it('maps the Type chip onto dataType[in] (real column name, not the display id)', async () => {
        const calls = stubFetch();
        const f = encodeURIComponent(JSON.stringify([['dataType', 'inArray', 'multiSelect', ['Json']]]));
        renderWithProviders(<SettingsScreen />, { searchParams: `?f=${f}` });
        await screen.findByText('smtp.host');

        const list = calls.map((call) => new URL(call.url, 'http://test.local')).find((url) => url.pathname === '/api/hope/admin/settings' && url.searchParams.get('filters'));
        expect(list?.searchParams.get('filters')).toBe('dataType[in]:Json');
    });

    it('maps the Secrets-only chip onto the bespoke secretsOnly param — never a filters token', async () => {
        const calls = stubFetch();
        const f = encodeURIComponent(JSON.stringify([['isSecret', 'eq', 'boolean', 'true']]));
        renderWithProviders(<SettingsScreen />, { searchParams: `?f=${f}` });
        await screen.findByText('smtp.host');

        const list = calls.map((call) => new URL(call.url, 'http://test.local')).find((url) => url.pathname === '/api/hope/admin/settings' && url.searchParams.get('secretsOnly'));
        expect(list?.searchParams.get('secretsOnly')).toBe('true');
        // isSecret is DERIVED (no column) — it must not leak into the bracket grammar.
        expect(list?.searchParams.get('filters')).toBeNull();
    });

    it('opens the detail drawer on row click and writes the ?setting= URL state', async () => {
        const updates: URLSearchParams[] = [];
        stubFetch();
        renderWithProviders(<SettingsScreen />, { onUrlUpdate: (event) => updates.push(event.searchParams) });

        fireEvent.click(await screen.findByText('smtp.host'));

        // The drawer opens (its own value editor renders once the fresh ETag loads).
        expect(await screen.findByRole('textbox', { name: 'Value' })).toBeDefined();
        expect(screen.getByRole('dialog')).toBeDefined();
        await waitFor(() => expect(updates.some((params) => params.get('setting') === 's-1')).toBe(true));
    });

    it('opens the create drawer from the New setting action', async () => {
        stubFetch({ rows: [] });
        renderWithProviders(<SettingsScreen />);

        fireEvent.click((await screen.findAllByRole('button', { name: 'New setting' }))[0]);

        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('New setting')).toBeDefined();
        expect(within(dialog).getByRole('button', { name: 'Create setting' })).toBeDefined();
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
