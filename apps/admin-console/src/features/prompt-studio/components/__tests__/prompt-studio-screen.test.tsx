/**
 * TDD screen tests screen 4 (Prompt Studio): the template list,
 * the detail (score + version history + server diff), the GLOBAL_ADMIN approve
 * action with If-Match OCC (+ 412 conflict), the read-only note for non-global
 * admins, the working-tenant gate and axe-cleanliness — against a URL-branching
 * fetch stub covering the BFF session route.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { renderWithProviders } from '@/test/render';
import type { PromptTemplate, PromptVersion, PromptVersionDiff } from '../../api/types';
import { PromptStudioScreen } from '../prompt-studio-screen';

expect.extend(axeMatchers);

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
    return {
        id: 'tpl-1',
        name: 'Pre-summary prompt',
        description: 'Generates the pre-consultation summary.',
        content: 'You are a clinical assistant.',
        category: 'SUMMARY',
        status: 'PUBLISHED',
        currentVersionNumber: 2,
        tags: [],
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        lastTestScore: 87,
        lastTestAt: '2026-07-02T00:00:00.000Z',
        version: 3,
        ...overrides,
    };
}

const VERSIONS: PromptVersion[] = [
    { id: 'v-1', promptTemplateId: 'tpl-1', versionNumber: 1, content: 'v1 content', createdAt: '2026-06-01T00:00:00.000Z', changedBy: 'admin' },
    { id: 'v-2', promptTemplateId: 'tpl-1', versionNumber: 2, content: 'v2 content', createdAt: '2026-07-01T00:00:00.000Z', changedBy: 'admin' },
];

const DIFF: PromptVersionDiff = {
    promptTemplateId: 'tpl-1',
    fromVersion: 1,
    toVersion: 2,
    changes: [
        { value: 'v1 ', removed: true },
        { value: 'v2 ', added: true },
        { value: 'content' },
    ],
    patch: '@@',
    stats: { additions: 1, deletions: 1, unchanged: 1 },
};

const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1' as string | null,
    workingTenantName: 'Sunrise Medical Group' as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: 'tnt-1' as string | null,
};

const TENANT_ADMIN_SESSION = {
    ...SESSION,
    user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    isElevated: false,
    effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    effectiveIsElevated: false,
};

interface RecordedCall {
    url: string;
    path: string;
    method: string;
    headers: Headers;
    body: unknown;
}

interface StubOptions {
    session?: typeof SESSION;
    templates?: PromptTemplate[];
    custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, templates = [template()], custom }: StubOptions = {}): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const call: RecordedCall = {
                url,
                path: url.split('?')[0],
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const handled = custom?.(call);
            if (handled) return handled;
            if (call.path === '/api/auth/session') return Response.json(session);
            if (call.method === 'GET' && call.path === '/api/hope/admin/prompt-templates') {
                return Response.json({ data: templates, count: templates.length, limit: 50, page: 1 });
            }
            if (call.method === 'GET' && call.path === '/api/hope/admin/prompt-templates/tpl-1') {
                return Response.json(templates[0], { headers: { etag: `"${templates[0].version}"` } });
            }
            if (call.method === 'GET' && call.path === '/api/hope/admin/prompt-templates/tpl-1/versions') {
                return Response.json(VERSIONS);
            }
            if (call.method === 'GET' && call.path === '/api/hope/admin/prompt-templates/tpl-1/versions/1/diff/2') {
                return Response.json(DIFF);
            }
            throw new Error(`Unhandled fetch: ${call.method} ${call.path}`);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('PromptStudioScreen', () => {
    it('lists templates with status + selects one to show the score and version history', async () => {
        stubFetch();
        renderWithProviders(<PromptStudioScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Prompt Studio' })).toBeDefined();
        const list = await screen.findByRole('list', { name: 'Prompt templates' });
        expect(list).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /Pre-summary prompt/ }));

        expect(await screen.findByText('87 / 100')).toBeDefined();
        expect(await screen.findByRole('list', { name: 'Versions of Pre-summary prompt' })).toBeDefined();
    });

    it('approves the selected template with If-Match + expectedVersion from the read ETag', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'POST' && call.path === '/api/hope/admin/prompt-templates/tpl-1/approve') {
                    return Response.json(template({ status: 'APPROVED', version: 4 }), { headers: { etag: '"4"' } });
                }
                return undefined;
            },
        });
        renderWithProviders(<PromptStudioScreen />, { searchParams: '?template=tpl-1' });

        fireEvent.change(await screen.findByLabelText('Approval reason'), { target: { value: 'reviewed by clinical lead' } });
        fireEvent.click(screen.getByRole('button', { name: /Approve for clinical use/ }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const approve = calls.find((call) => call.method === 'POST');
        expect(approve?.path).toBe('/api/hope/admin/prompt-templates/tpl-1/approve');
        expect(approve?.headers.get('if-match')).toBe('"3"');
        expect(approve?.body).toEqual({ expectedVersion: 3, reason: 'reviewed by clinical lead' });
    });

    it('shows the OCC conflict alert with reload when approve returns 412', async () => {
        stubFetch({
            custom: (call) => {
                if (call.method === 'POST') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
                return undefined;
            },
        });
        renderWithProviders(<PromptStudioScreen />, { searchParams: '?template=tpl-1' });

        fireEvent.click(await screen.findByRole('button', { name: /Approve for clinical use/ }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    });

    it('hides the approve panel from a non-global-admin session', async () => {
        stubFetch({ session: TENANT_ADMIN_SESSION });
        renderWithProviders(<PromptStudioScreen />, { searchParams: '?template=tpl-1' });

        expect(await screen.findByText(/Prompt approval is a global-admin privilege/)).toBeDefined();
        expect(screen.queryByRole('button', { name: /Approve for clinical use/ })).toBeNull();
    });

    it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
        stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
        renderWithProviders(<PromptStudioScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(screen.queryByRole('list', { name: 'Prompt templates' })).toBeNull();
    });

    it('has no axe violations on the list + detail', async () => {
        stubFetch();
        const { container } = renderWithProviders(<PromptStudioScreen />, { searchParams: '?template=tpl-1' });
        await screen.findByText('87 / 100');
        expect(await axe(container)).toHaveNoViolations();
    });
});
