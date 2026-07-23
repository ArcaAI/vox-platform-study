/**
 * Frame 32 — Agents & Prompt Templates screen (build spec §7 redesign:
 * fill-height grid + console-wide detail slide-over). fetch is stubbed at the
 * network boundary; assertions cover the template grid, the working-tenant
 * gate, the detail drawer following the row selection, the Versions-tab
 * confirm-gated activate POST, the Test-run-tab OCC write, create-in-drawer and
 * the block error state.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Department, PromptTemplate, PromptUsageAnalytics, PromptVersion } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
    return {
        id: 'pt-1',
        name: 'Cardiology Notes',
        description: 'SOAP output for cardiology consults',
        content: 'You are a clinical scribe.',
        category: 'SUMMARY',
        status: 'PUBLISHED',
        currentVersionNumber: 7,
        departmentId: 'd-1',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-07-02T10:00:00.000Z',
        resourceStatus: 'ENABLED',
        version: 7,
        ...overrides,
    };
}

const TEMPLATES: PromptTemplate[] = [
    template(),
    template({ id: 'pt-2', name: 'Discharge Summary', departmentId: undefined, currentVersionNumber: 12, version: 3 }),
    template({ id: 'pt-3', name: 'Radiology Report', departmentId: 'd-2', currentVersionNumber: 4, status: 'DRAFT', version: 2 }),
];

const DEPARTMENTS: Department[] = [
    {
        id: 'd-1',
        code: 'CARD',
        name: 'Cardiology',
        isRootDepartment: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 3,
    },
    {
        id: 'd-2',
        code: 'RADIO',
        name: 'Radiology',
        isRootDepartment: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 5,
    },
];

function version(templateId: string, versionNumber: number, overrides: Partial<PromptVersion> = {}): PromptVersion {
    return {
        id: `pv-${templateId}-${versionNumber}`,
        promptTemplateId: templateId,
        versionNumber,
        content: `Prompt body v${versionNumber}`,
        changedBy: 'taphuynh',
        createdAt: '2026-06-20T10:00:00.000Z',
        ...overrides,
    };
}

const VERSIONS: Record<string, PromptVersion[]> = {
    'pt-1': [version('pt-1', 7, { createdAt: '2026-07-02T10:00:00.000Z' }), version('pt-1', 6, { changedBy: 'minh.tran' }), version('pt-1', 5), version('pt-1', 4, { changedBy: 'dr.lee' })],
    'pt-2': [version('pt-2', 12, { changedBy: 'minh.tran' }), version('pt-2', 11)],
    'pt-3': [version('pt-3', 4)],
};

const ANALYTICS: PromptUsageAnalytics = {
    totalUsages: 1204,
    byDepartment: [{ departmentId: 'd-1', count: 1204 }],
    byDoctor: [{ doctorId: 'doc-1', count: 1204 }],
    byDay: [{ day: new Date().toISOString().slice(0, 10), count: 42 }],
};

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
            };
            calls.push(call);
            const response = handler(call);
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function session(overrides: Partial<{ workingTenantId: string | null }> = {}) {
    const base = {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId: 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...overrides,
    };
    // WorkingTenantGate now reads the effective identity; mirror the
    // (possibly overridden) operator fields since these fixtures never impersonate.
    return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: base.isElevated, effectiveTenantId: base.workingTenantId };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = new URL(call.url, 'http://test.local').pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
    // The Agents tab (TASK-547, default landing) — empty by default so the
    // Agent Templates-tab tests below (which stay unaffected by this ticket)
    // don't need to know about it.
    if (path === '/api/hope/admin/department-agents') return Response.json({ data: [], count: 0, limit: 200, page: 0 });
    if (path === '/api/hope/admin/prompt-templates') {
        return Response.json({ data: TEMPLATES, count: TEMPLATES.length, limit: 10, page: 1 });
    }
    if (path === '/api/hope/admin/prompt-templates/analytics/usage') return Response.json(ANALYTICS);
    if (path === '/api/hope/admin/prompt-templates/usage-records') {
        return Response.json({
            data: [{ id: 'ur-1', promptTemplateId: 'pt-1', promptVersionNumber: 7, createdAt: '2026-07-01T09:00:00.000Z' }],
            count: 1,
            limit: 5,
            page: 0,
        });
    }
    const detail = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)$/);
    if (detail) {
        const row = TEMPLATES.find((entry) => entry.id === detail[1]);
        return row ? Response.json(row, { headers: { etag: `"${row.version}"` } }) : undefined;
    }
    const versions = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/versions$/);
    if (versions) return Response.json(VERSIONS[versions[1]] ?? []);
    const usage = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/usage$/);
    if (usage) return Response.json({ totalUsages: usage[1] === 'pt-1' ? 1204 : 64, lastUsedAt: '2026-07-01T09:00:00.000Z' });
    const diff = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-\d)\/versions\/(\d+)\/diff\/(\d+)$/);
    if (diff) {
        return Response.json({
            promptTemplateId: diff[1],
            fromVersion: Number(diff[2]),
            toVersion: Number(diff[3]),
            fields: [],
            changes: [
                { value: 'You are a clinical scribe.\n', count: 1 },
                { value: 'Be brief.\n', removed: true, count: 1 },
                { value: 'Be thorough and structured.\n', added: true, count: 1 },
            ],
            patch: '@@ -1,2 +1,2 @@',
            stats: { additions: 1, deletions: 1, unchanged: 1 },
        });
    }
    return undefined;
}

/** Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved layout in tests. */
function settingsResponse(call: RecordedCall): Response | undefined {
    if (!call.url.includes('/user/me/settings')) return undefined;
    return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubAgents(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => settingsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

/** Open the detail drawer for a row and wait for its detail read to land. */
async function openRow(name: string) {
    fireEvent.click(await screen.findByText(name));
    return screen.findByRole('dialog');
}

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('AgentsScreen', () => {
    it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
        const calls = stubAgents((call) => {
            if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<AgentsScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.includes('/admin/prompt-templates'))).toBe(true);
    });

    it('lands on the Agents tab by default with the Agent Catalog page title (TASK-547 naming rollout)', async () => {
        stubAgents();
        renderWithProviders(<AgentsScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Agent Catalog' })).toBeDefined();
        expect(await screen.findByRole('tab', { name: 'Agents', selected: true })).toBeDefined();
        // The Agent Templates grid (this test's default stub carries no
        // department agents) is NOT mounted on the default tab.
        expect(screen.queryByText('Cardiology Notes')).toBeNull();
    });

    it('renders the fill-height template grid with department, type, active version and usage columns', async () => {
        stubAgents();
        renderWithProviders(<AgentsScreen />, { searchParams: '?tab=templates' });

        expect(await screen.findByText('Cardiology Notes')).toBeDefined();
        expect(screen.getByText('Discharge Summary')).toBeDefined();
        expect(screen.getByText('Radiology Report')).toBeDefined();
        expect(screen.getByText(/3 templates/)).toBeDefined();
        expect(screen.getByText('CARD')).toBeDefined();
        // Type (category) column renders the label.
        expect(screen.getAllByText('Summary').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('v12')).toBeDefined();
        expect(await screen.findAllByText('1,204')).toBeDefined();
        // No detail slide-over until a row is selected.
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens the detail slide-over on the clicked row (Overview tab seeds the edit form)', async () => {
        stubAgents();
        renderWithProviders(<AgentsScreen />, { searchParams: '?tab=templates' });

        await openRow('Discharge Summary');
        // Overview is the landing tab: the edit form seeds the name.
        expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Discharge Summary');
    });

    it('lists versions in the drawer Versions tab', async () => {
        // Land on the Versions tab directly — Radix tab activation is unreliable
        // under fireEvent.click in jsdom, so selection + tab come from the URL.
        const calls = stubAgents();
        renderWithProviders(<AgentsScreen />, { searchParams: '?template=pt-2&atab=versions' });

        const timeline = await screen.findByLabelText('Versions of Discharge Summary');
        expect(within(timeline).getByText('v12')).toBeDefined();
        expect(within(timeline).getByText('minh.tran')).toBeDefined();
        await waitFor(() => expect(calls.some((call) => pathOf(call) === '/api/hope/admin/prompt-templates/pt-2/versions')).toBe(true));
    });

    it('swaps the drawer content when a different row is selected (one detail surface)', async () => {
        stubAgents();
        renderWithProviders(<AgentsScreen />, { searchParams: '?tab=templates' });

        await openRow('Discharge Summary');
        expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Discharge Summary');

        fireEvent.click(screen.getByText('Radiology Report'));
        await waitFor(() => expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Radiology Report'));
        // Exactly one detail surface at a time.
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });

    it('activates an older version from the Versions tab behind a confirm dialog', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate') {
                return Response.json({ ...TEMPLATES[0], currentVersionNumber: 8, version: 8 });
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />, { searchParams: '?template=pt-1&atab=versions' });

        // Default diff picks v6 (previous) as the "from" side of v6 <-> v7.
        fireEvent.click(await screen.findByRole('button', { name: 'Activate v6' }));
        const confirm = await screen.findByRole('alertdialog');
        expect(within(confirm).getByText(/activate version 6/i)).toBeDefined();
        fireEvent.click(within(confirm).getByRole('button', { name: 'Activate v6' }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate')).toBe(
                true,
            ),
        );
    });

    it('runs a prompt test from the Test-run tab as an OCC write and renders the output', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/test') {
                return Response.json({
                    id: 'pt-1',
                    score: 0.87,
                    output: 'S: Chest pain. O: Stable. A: Angina. P: Follow-up.',
                    testedAt: '2026-07-05T07:00:00.000Z',
                    version: 8,
                });
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />, { searchParams: '?template=pt-1&atab=test' });

        fireEvent.change(await screen.findByLabelText('Sample input'), { target: { value: 'Patient reports chest pain.' } });
        const runButton = screen.getByRole('button', { name: /run test/i }) as HTMLButtonElement;
        // The button arms once the detail read has delivered the If-Match ETag.
        await waitFor(() => expect(runButton.disabled).toBe(false));
        fireEvent.click(runButton);

        expect(await screen.findByText(/A: Angina/)).toBeDefined();
        const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/test');
        expect(post?.headers['if-match']).toBe('"7"');
        expect(post?.body).toEqual({ sampleInput: 'Patient reports chest pain.', expectedVersion: 7 });
    });

    it('creates a template from the drawer create mode (no modal)', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates') {
                return Response.json(template({ id: 'pt-9', name: 'Nephrology Notes' }));
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />, { searchParams: '?tab=templates' });

        fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Name' }), { target: { value: 'Nephrology Notes' } });
        fireEvent.change(within(dialog).getByRole('textbox', { name: /Prompt content/ }), { target: { value: 'You are a scribe.' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates');
            expect(post?.body).toMatchObject({ name: 'Nephrology Notes', content: 'You are a scribe.' });
        });
    });

    it('renders the block error state and retries the templates request', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/prompt-templates') {
                return Response.json({ message: 'Service unavailable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />, { searchParams: '?tab=templates' });

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/prompt-templates').length).toBe(2));
    });

    /**
     * Prompt governance folded in from the retired
     * `/prompt-studio`. The Governance tab is elevated-only in the CONSOLE;
     * approve authority stays server-side (GLOBAL_ADMIN 403 in the service)
     * regardless of what the console renders.
     */
    describe('Governance tab', () => {
        it('is hidden for a non-elevated session', async () => {
            stubAgents((call) => {
                if (pathOf(call) === '/api/auth/session') {
                    const base = session();
                    return Response.json({
                        ...base,
                        user: { ...base.user, roles: ['TENANT_ADMIN'] },
                        isElevated: false,
                        effectiveIsElevated: false,
                    });
                }
                return undefined;
            });
            renderWithProviders(<AgentsScreen />);

            await screen.findByRole('tab', { name: 'Agents' });
            expect(screen.getByRole('tab', { name: 'Agent Templates' })).toBeDefined();
            expect(screen.queryByRole('tab', { name: 'Governance' })).toBeNull();
        });

        it('is visible for an elevated session and opens on the redirect target ?tab=governance', async () => {
            stubAgents();
            // `/prompt-studio` redirects to exactly this URL, so the tab must be
            // URL-addressable — asserting via searchParams tests that contract.
            renderWithProviders(<AgentsScreen />, { searchParams: '?tab=governance' });

            expect(await screen.findByRole('tab', { name: 'Governance' })).toBeDefined();
            expect(await screen.findByRole('heading', { name: /prompt governance/i })).toBeDefined();
        });

        it('approves a template as an OCC write carrying If-Match', async () => {
            const calls = stubAgents((call) => {
                if (call.method === 'POST' && pathOf(call).endsWith('/approve')) {
                    return Response.json({ ...TEMPLATES[0], status: 'APPROVED', version: TEMPLATES[0].version + 1 });
                }
                return undefined;
            });
            renderWithProviders(<AgentsScreen />, { searchParams: '?tab=governance' });

            fireEvent.click(await screen.findByText(TEMPLATES[0].name));
            fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

            await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/approve'))).toBe(true));
            const approve = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/approve'));
            expect(approve?.headers['if-match']).toBe(`"${TEMPLATES[0].version}"`);
            expect((approve?.body as { expectedVersion: number }).expectedVersion).toBe(TEMPLATES[0].version);
        });
    });
});
