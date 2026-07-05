/**
 * Frame 34 — Audio pipelines screen. fetch is stubbed at the network
 * boundary; assertions cover the grid, the NoTenant gate, the validate
 * preflight, the toggle + set-default lifecycle mutations and the block
 * error state.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Pipeline, PipelineVersion } from '../../api/types';
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
        isDefault: true,
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

const PIPELINES: Pipeline[] = [
    pipeline(),
    pipeline({
        id: 'p-2',
        name: 'Legacy Batch',
        slug: 'legacy-batch',
        configYaml: 'models:\n  asr: whisper-base\n',
        resourceStatus: 'DISABLED',
        isDefault: false,
        version: 1,
    }),
];

const VERSIONS: PipelineVersion[] = [
    {
        id: 'v-12',
        asrPipelineId: 'p-1',
        versionNumber: 12,
        configYaml: 'models:\n  asr: whisper-large-v4\n',
        name: 'Fast Clinical VI',
        description: null,
        changeReason: 'Switched ASR model',
        changedBy: 'u-1',
        createdAt: '2026-07-01T10:00:00.000Z',
    },
];

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

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
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

function defaultHandler(call: RecordedCall): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = new URL(call.url, 'http://test.local').pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/audio/pipelines') return Response.json(PIPELINES);
    if (path === '/api/hope/admin/audio/pipelines/p-1') return Response.json(PIPELINES[0], { headers: { etag: '"3"' } });
    if (path === '/api/hope/admin/audio/pipelines/p-2') return Response.json(PIPELINES[1], { headers: { etag: '"1"' } });
    if (path.endsWith('/versions')) return Response.json(VERSIONS);
    return undefined;
}

function stubPipelines(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('AudioPipelinesScreen', () => {
    it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
        const calls = stubPipelines((call) => {
            const path = new URL(call.url, 'http://test.local').pathname;
            if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.includes('/admin/audio/pipelines'))).toBe(true);
    });

    it('renders the pipeline grid with slug, default star and paired status badges', async () => {
        stubPipelines();
        renderWithProviders(<AudioPipelinesScreen />);

        expect(await screen.findByText('Fast Clinical VI')).toBeDefined();
        expect(screen.getByText('Legacy Batch')).toBeDefined();
        expect(screen.getByText('fast-clin-vi')).toBeDefined();
        expect(screen.getByText('On')).toBeDefined();
        expect(screen.getByText('Off')).toBeDefined();
        expect(screen.getByText('Tenant default')).toBeDefined();
        expect(screen.getByText(/2 pipelines/)).toBeDefined();
    });

    it('runs the validate preflight over the selected config and shows the verdict inline', async () => {
        const calls = stubPipelines((call) => {
            if (call.method === 'POST' && call.url.endsWith('/admin/audio/pipelines/validate')) return Response.json({ valid: true });
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);

        fireEvent.click(await screen.findByText('Fast Clinical VI'));
        const validateButton = await screen.findByRole('button', { name: /validate/i });
        fireEvent.click(validateButton);

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/admin/audio/pipelines/validate'));
            expect(post?.body).toEqual({ configYaml: PIPELINES[0].configYaml });
        });
        expect(await screen.findByText('Config is valid')).toBeDefined();
    });

    it('toggles the selected pipeline with If-Match and an { enabled } body', async () => {
        const calls = stubPipelines((call) => {
            if (call.method === 'PATCH' && call.url.endsWith('/admin/audio/pipelines/p-1/toggle')) {
                return Response.json({ ...PIPELINES[0], resourceStatus: 'DISABLED' }, { headers: { etag: '"4"' } });
            }
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);

        fireEvent.click(await screen.findByText('Fast Clinical VI'));
        const toggleButton = await screen.findByRole('button', { name: /disable/i });
        await waitFor(() => expect((toggleButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(toggleButton);

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/audio/pipelines/p-1/toggle'));
            expect(patch?.body).toEqual({ enabled: false });
            expect(patch?.ifMatch).toBe('"3"');
        });
    });

    it('sets a non-default pipeline as the tenant default behind a confirm', async () => {
        const calls = stubPipelines((call) => {
            if (call.method === 'POST' && call.url.endsWith('/admin/audio/pipelines/p-2/set-default')) {
                return Response.json({ ...PIPELINES[1], isDefault: true });
            }
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);

        fireEvent.click(await screen.findByText('Legacy Batch'));
        const setDefaultButton = await screen.findByRole('button', { name: /set default/i });
        await waitFor(() => expect((setDefaultButton as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(setDefaultButton);

        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /set default/i }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/admin/audio/pipelines/p-2/set-default'))).toBe(true),
        );
    });

    it('renders the block error state when the pipelines read fails', async () => {
        stubPipelines((call) => {
            if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/audio/pipelines') {
                return Response.json({ message: 'Service unavailable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<AudioPipelinesScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();
    });
});
