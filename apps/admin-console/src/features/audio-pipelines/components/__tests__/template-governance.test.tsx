/**
 * Template governance on frame 34.
 *
 * A tenant's provisioned pipelines are LOCKED copies of the SYSTEM templates:
 * the gateway answers PATCH/DELETE on them with 403. The console's job is to
 * make that legible BEFORE the user invests effort — badge the rows, render the
 * detail read-only with the reason stated, and offer Clone as the way forward —
 * rather than letting them write a config and discover the refusal on Save.
 *
 * Deep-linking to a locked row must still render its detail (it exists and is
 * the caller's own row), never a 404.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Pipeline } from '../../api/types';
import { AudioPipelinesScreen } from '../audio-pipelines-screen';


vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
    return {
        id: 'p-1',
        name: 'Fast Clinical VI',
        slug: 'fast-clin-vi',
        description: null,
        configYaml: 'models:\n  asr: whisper-large-v4\n',
        resourceStatus: 'ENABLED',
        isDefault: false,
        sourceTemplateSlug: null,
        templateLocked: false,
        tags: [],
        tenantId: 'tnt-1',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
        createdBy: null,
        updatedBy: null,
        version: 3,
        ...overrides,
    };
}

/** A provisioned SYSTEM-template copy: locked, with provenance. */
const LOCKED = pipeline({
    id: 'p-tpl',
    name: 'Production Whisper GGUF',
    slug: 'production-whisper-large-v3-turbo-gguf',
    sourceTemplateSlug: 'production-whisper-large-v3-turbo-gguf',
    templateLocked: true,
    isDefault: true,
});

/** A pipeline the tenant made themselves: fully editable. */
const OWN = pipeline({ id: 'p-own', name: 'Legacy Batch', slug: 'legacy-batch' });

const PIPELINES: Pipeline[] = [LOCKED, OWN];

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
    ifMatch: string | null;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            const call: RecordedCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
                ifMatch: headers.get('if-match'),
            };
            calls.push(call);
            const response = handler(call);
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function session() {
    const base = {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId: 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
    };
    return {
        ...base,
        effectiveUser: { ...base.user, tenantId: null, departmentId: null },
        effectiveIsElevated: base.isElevated,
        effectiveTenantId: base.workingTenantId,
    };
}

function defaultHandler(call: RecordedCall): Response | undefined {
    if (call.url.includes('/user/me/settings')) {
        return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
    }
    if (call.method !== 'GET') return undefined;
    const path = new URL(call.url, 'http://test.local').pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/audio/pipelines') return Response.json(PIPELINES);
    if (path === '/api/hope/admin/audio/pipelines/p-tpl') return Response.json(LOCKED, { headers: { etag: '"3"' } });
    if (path === '/api/hope/admin/audio/pipelines/p-own') return Response.json(OWN, { headers: { etag: '"3"' } });
    if (path.endsWith('/versions')) return Response.json([]);
    return undefined;
}

function stubPipelines(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

async function openRow(name: string) {
    fireEvent.click(await screen.findByText(name));
    return screen.findByRole('dialog');
}

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('TASK-531 — template copies in the grid', () => {
    it('badges locked template copies and leaves the tenant’s own pipelines unbadged', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />);

        // Scope to each grid row — "Template" is also the column header.
        const lockedRow = (await screen.findByText('Production Whisper GGUF')).closest('[role="row"]');
        const ownRow = screen.getByText('Legacy Batch').closest('[role="row"]');

        expect(within(lockedRow as HTMLElement).getByText('Template')).toBeDefined();
        expect(within(ownRow as HTMLElement).queryByText('Template')).toBeNull();
    });
});

describe('TASK-531 — locked detail is read-only', () => {
    it('states the reason, makes the YAML read-only and hides Save', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />);
        const dialog = await openRow('Production Whisper GGUF');

        expect(
            await within(dialog).findByText(/Template copies are read-only/),
        ).toBeDefined();
        // The config buffer is visible but not editable…
        const yaml = within(dialog).getByRole('textbox', { name: /Config YAML/ });
        expect(yaml.hasAttribute('readonly')).toBe(true);
        // …and Save is absent rather than disabled — Clone is the real action.
        expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
        expect(within(dialog).getByRole('button', { name: /Clone to customize/ })).toBeDefined();
    });

    it('shows the template provenance', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />);
        const dialog = await openRow('Production Whisper GGUF');

        expect(await within(dialog).findByText(/Derived from/)).toBeDefined();
    });

    // The lock covers content only; the tenant still owns the lifecycle.
    it('keeps enable/disable and set-default available, and withholds Delete', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />, { searchParams: '?pipeline=p-tpl&ptab=lifecycle' });

        expect(await screen.findByRole('button', { name: /disable/i })).toBeDefined();
        expect(screen.getByRole('button', { name: /tenant default|set default/i })).toBeDefined();
        // Delete would 403 on a locked copy — Clone stands in its place.
        expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
        expect(screen.getByRole('button', { name: /Clone to customize/ })).toBeDefined();
    });

    it('keeps the tenant’s OWN pipeline fully editable', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />);
        const dialog = await openRow('Legacy Batch');

        const yaml = await within(dialog).findByRole('textbox', { name: /Config YAML/ });
        expect(yaml.hasAttribute('readonly')).toBe(false);
        expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDefined();
        expect(within(dialog).queryByText(/Template copies are read-only/)).toBeNull();
    });
});

describe('TASK-531 — clone flow', () => {
    it('prefills a copy identity and POSTs it to the clone route', async () => {
        const calls = stubPipelines((call) => {
            if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/audio/pipelines/p-tpl/clone') {
                return Response.json(pipeline({ id: 'p-new', name: 'My copy', slug: 'my-copy' }), { status: 201 });
            }
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);
        const dialog = await openRow('Production Whisper GGUF');
        fireEvent.click(await within(dialog).findByRole('button', { name: /Clone to customize/ }));

        // The clone dialog opens prefilled from the source.
        const nameField = (await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement;
        const slugField = screen.getByRole('textbox', { name: 'Slug' }) as HTMLInputElement;
        expect(nameField.value).toBe('Production Whisper GGUF copy');
        expect(slugField.value).toBe('production-whisper-large-v3-turbo-gguf-copy');

        fireEvent.change(nameField, { target: { value: 'My copy' } });
        fireEvent.change(slugField, { target: { value: 'my-copy' } });
        fireEvent.click(screen.getByRole('button', { name: /Clone pipeline/ }));

        await waitFor(() => {
            const post = calls.find(
                (call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/audio/pipelines/p-tpl/clone',
            );
            // Whitelist-only body: identity and nothing else.
            expect(post?.body).toEqual({ name: 'My copy', slug: 'my-copy' });
            // Never an If-Match — a clone creates a row, it does not edit one.
            expect(post?.ifMatch).toBeNull();
        });
    });
});

describe('TASK-531 — deep links and accessibility', () => {
    // A locked row is the caller's OWN row: it exists, so a deep link must land
    // on the read-only detail, not an error state.
    it('deep-linking to a locked pipeline renders the read-only detail, not a 404', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />, { searchParams: '?pipeline=p-tpl' });

        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByText(/Template copies are read-only/)).toBeDefined();
        expect(within(dialog).queryByText(/does not exist|outside your access scope/i)).toBeNull();
    });

    // Scoped to the drawer, matching the house precedent: with a modal open,
    // Radix marks the page behind it aria-hidden while its focusables stay in
    // the DOM, so a whole-container scan reports that framework artifact rather
    // than anything about this screen.
    it('the locked detail has no axe violations', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />, { searchParams: '?pipeline=p-tpl' });
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByText(/Template copies are read-only/);

        expect(await axe(dialog)).toHaveNoViolations();
    });
});
