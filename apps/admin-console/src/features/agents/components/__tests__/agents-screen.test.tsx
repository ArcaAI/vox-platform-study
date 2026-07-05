/**
 * Frame 32 — Agents & Prompt Templates screen. fetch is stubbed at the
 * network boundary; assertions cover the template grid, the working-tenant
 * gate, the versions panel following the row selection, the confirm-gated
 * version activate POST, the OCC test run and the block error state.
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
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId: 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...overrides,
    };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = new URL(call.url, 'http://test.local').pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
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

function stubAgents(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

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

    it('renders the template grid with department, active version and usage columns', async () => {
        stubAgents();
        renderWithProviders(<AgentsScreen />);

        // The name appears in its row AND the "selected:" footer (auto-select).
        expect((await screen.findAllByText('Cardiology Notes')).length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('Discharge Summary')).toBeDefined();
        expect(screen.getByText('Radiology Report')).toBeDefined();
        expect(screen.getByText(/3 templates/)).toBeDefined();
        expect(screen.getByText('CARD')).toBeDefined();
        expect(screen.getByText('v12')).toBeDefined();
        expect(await screen.findAllByText('1,204')).toBeDefined();
        // The first row is auto-selected and drives the side panels.
        expect(await screen.findByLabelText('Versions of Cardiology Notes')).toBeDefined();
        expect(screen.getByText(/selected:/)).toBeDefined();
    });

    it('loads the clicked row into the versions panel', async () => {
        const calls = stubAgents();
        renderWithProviders(<AgentsScreen />);

        fireEvent.click(await screen.findByText('Discharge Summary'));

        const timeline = await screen.findByLabelText('Versions of Discharge Summary');
        expect(within(timeline).getByText('v12')).toBeDefined();
        expect(within(timeline).getByText('minh.tran')).toBeDefined();
        await waitFor(() => expect(calls.some((call) => pathOf(call) === '/api/hope/admin/prompt-templates/pt-2/versions')).toBe(true));
    });

    it('activates an older version behind a confirm dialog', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate') {
                return Response.json({ ...TEMPLATES[0], currentVersionNumber: 8, version: 8 });
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />);

        // Default diff picks v6 (previous) as the "from" side of v6 <-> v7.
        fireEvent.click(await screen.findByRole('button', { name: 'Activate v6' }));
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText(/activate version 6/i)).toBeDefined();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Activate v6' }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate')).toBe(
                true,
            ),
        );
    });

    it('runs a prompt test as an OCC write and renders the returned output', async () => {
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
        renderWithProviders(<AgentsScreen />);

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

    it('renders the block error state and retries the templates request', async () => {
        const calls = stubAgents((call) => {
            if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/prompt-templates') {
                return Response.json({ message: 'Service unavailable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<AgentsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/prompt-templates').length).toBe(2));
    });
});
