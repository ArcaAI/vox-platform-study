/**
 * TDD screen tests screen 5 (Tools & MCP): MCP external-tools
 * registry — list table, create/edit (If-Match OCC),
 * delete, GLOBAL_ADMIN gate, empty/error/loading, axe 0-violations. Data is a
 * URL-branching fetch stub over GET/POST/PATCH/DELETE /admin/mcp-servers.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { McpServer, McpServerListResponse } from '../../api/types';
import { ToolsMcpScreen } from '../tools-mcp-screen';


vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: null as string | null,
    workingTenantName: null as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: null as string | null,
};

const TENANT_ADMIN_SESSION = {
    ...SESSION,
    user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    isElevated: false,
    effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    effectiveIsElevated: false,
};

const SERVER: McpServer = {
    id: 'mcp-1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    name: 'fhir-terminology',
    description: 'FHIR terminology lookup',
    baseUrl: 'https://terminology.internal/mcp',
    transport: 'streamable-http',
    authRef: 'secret/data/mcp/terminology',
    toolAllowlist: ['lookup-code', 'expand-value-set'],
    phiBoundary: 'external',
    enabled: true,
    resourceStatus: 'ENABLED',
    version: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
};

function envelope(items: McpServer[]): McpServerListResponse {
    return { items, total: items.length };
}

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input).split('?')[0];
            const method = init?.method ?? 'GET';
            calls.push({
                url,
                method,
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            if (url === '/api/auth/session') return Response.json(SESSION);
            return handler(url, method);
        }),
    );
    return calls;
}

function stubFetchWithSession(
    session: typeof SESSION,
    handler: (url: string, method: string) => Response | Promise<Response>,
): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input).split('?')[0];
            const method = init?.method ?? 'GET';
            calls.push({
                url,
                method,
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            if (url === '/api/auth/session') return Response.json(session);
            return handler(url, method);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('ToolsMcpScreen', () => {
    it('renders the MCP registry table with allowlist, phi boundary, enabled, and masked auth presence', async () => {
        stubFetch((url) => {
            if (url === '/api/hope/admin/mcp-servers') return Response.json(envelope([SERVER]));
            throw new Error(`Unhandled fetch: ${url}`);
        });
        renderWithProviders(<ToolsMcpScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Tools & MCP' })).toBeDefined();
        expect(await screen.findByRole('table', { name: 'MCP servers' })).toBeDefined();
        expect(screen.getByText('fhir-terminology')).toBeDefined();
        expect(screen.getByText('external')).toBeDefined();
        expect(screen.getByText('lookup-code')).toBeDefined();
        expect(screen.getByText('Enabled')).toBeDefined();
        // authRef is Vault-path presence only — never echo the path string in the table.
        expect(screen.getByText('Configured')).toBeDefined();
        expect(screen.queryByText('secret/data/mcp/terminology')).toBeNull();
        expect(screen.queryByText('Read-only registry')).toBeNull();
        expect(screen.queryByText('Entity faithfulness')).toBeNull();
    });

    it('gates non-elevated sessions behind the Global admins only empty state', async () => {
        stubFetchWithSession(TENANT_ADMIN_SESSION, () => {
            throw new Error('mcp-servers must not be fetched for tenant admins');
        });
        renderWithProviders(<ToolsMcpScreen />);

        expect(await screen.findByText('Global admins only')).toBeDefined();
        expect(screen.queryByRole('table', { name: 'MCP servers' })).toBeNull();
    });

    it('mirrors the loaded layout with skeletons while the list is in flight', () => {
        stubFetch(() => new Promise<Response>(() => {}));
        const { container } = renderWithProviders(<ToolsMcpScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByText('fhir-terminology')).toBeNull();
    });

    it('shows the empty state with a register CTA when no servers exist', async () => {
        stubFetch((url) => {
            if (url === '/api/hope/admin/mcp-servers') return Response.json(envelope([]));
            throw new Error(`Unhandled fetch: ${url}`);
        });
        renderWithProviders(<ToolsMcpScreen />);

        expect(await screen.findByText('No MCP servers registered yet')).toBeDefined();
        expect(screen.getAllByRole('button', { name: /register server/i }).length).toBeGreaterThanOrEqual(1);
    });

    it('surfaces a block error with retry and refetches the list', async () => {
        let attempts = 0;
        stubFetch((url) => {
            if (url !== '/api/hope/admin/mcp-servers') throw new Error(`Unhandled fetch: ${url}`);
            attempts += 1;
            return attempts === 1
                ? Response.json({ message: 'Service Unavailable' }, { status: 503 })
                : Response.json(envelope([SERVER]));
        });
        renderWithProviders(<ToolsMcpScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('Service Unavailable')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByText('fhir-terminology')).toBeDefined();
    });

    it('registers a server by POSTing the form payload', async () => {
        const calls = stubFetch((url, method) => {
            if (url === '/api/hope/admin/mcp-servers' && method === 'GET') return Response.json(envelope([]));
            if (url === '/api/hope/admin/mcp-servers' && method === 'POST') {
                return Response.json({ ...SERVER, id: 'mcp-2', name: 'local-tools' }, { status: 201 });
            }
            throw new Error(`Unhandled fetch: ${url} ${method}`);
        });
        renderWithProviders(<ToolsMcpScreen />);
        await screen.findByText('No MCP servers registered yet');

        fireEvent.click(screen.getAllByRole('button', { name: /register server/i })[0]);
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'local-tools' } });
        fireEvent.change(within(dialog).getByLabelText(/^base url/i), { target: { value: 'https://tools.local/mcp' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /register server/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toContain('/api/hope/admin/mcp-servers');
        expect(post?.body).toMatchObject({
            name: 'local-tools',
            baseUrl: 'https://tools.local/mcp',
        });
    });

    it('PATCHes an edit with If-Match from the read ETag', async () => {
        const calls = stubFetch((url, method) => {
            if (url === '/api/hope/admin/mcp-servers' && method === 'GET') return Response.json(envelope([SERVER]));
            if (url === `/api/hope/admin/mcp-servers/${SERVER.id}` && method === 'GET') {
                return new Response(JSON.stringify(SERVER), {
                    status: 200,
                    headers: { 'content-type': 'application/json', etag: '"2"' },
                });
            }
            if (url === `/api/hope/admin/mcp-servers/${SERVER.id}` && method === 'PATCH') {
                return new Response(JSON.stringify({ ...SERVER, enabled: false, version: 3 }), {
                    status: 200,
                    headers: { 'content-type': 'application/json', etag: '"3"' },
                });
            }
            throw new Error(`Unhandled fetch: ${url} ${method}`);
        });
        renderWithProviders(<ToolsMcpScreen />);
        await screen.findByText('fhir-terminology');

        fireEvent.click(screen.getByRole('button', { name: /edit fhir-terminology/i }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByDisplayValue('fhir-terminology');

        const enabled = within(dialog).getByLabelText(/^enabled/i);
        fireEvent.click(enabled);
        fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.headers.get('if-match')).toBe('"2"');
        expect(patch?.body).toMatchObject({ expectedVersion: 2, enabled: false });
    });

    it('DELETEs with If-Match from the list row version', async () => {
        const calls = stubFetch((url, method) => {
            if (url === '/api/hope/admin/mcp-servers' && method === 'GET') return Response.json(envelope([SERVER]));
            if (url === `/api/hope/admin/mcp-servers/${SERVER.id}` && method === 'DELETE') {
                return Response.json(SERVER);
            }
            throw new Error(`Unhandled fetch: ${url} ${method}`);
        });
        renderWithProviders(<ToolsMcpScreen />);
        await screen.findByText('fhir-terminology');

        fireEvent.click(screen.getByRole('button', { name: /delete fhir-terminology/i }));
        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /delete server/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
        const del = calls.find((call) => call.method === 'DELETE');
        expect(del?.headers.get('if-match')).toBe('"2"');
    });

    it('has no axe violations with the registry rendered', async () => {
        stubFetch((url) => {
            if (url === '/api/hope/admin/mcp-servers') return Response.json(envelope([SERVER]));
            throw new Error(`Unhandled fetch: ${url}`);
        });
        const { container } = renderWithProviders(<ToolsMcpScreen />);
        await screen.findByRole('table', { name: 'MCP servers' });
        expect(await axe(container)).toHaveNoViolations();
    });
});
