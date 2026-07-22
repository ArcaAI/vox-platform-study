/**
 * TDD screen tests for frame 15 (AI Model Registry): the three list states,
 * register/edit (OCC If-Match + 412 alert) and destructive delete flows,
 * against a URL-branching fetch stub (per the feature-api test pattern).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AiModel, PaginatedModels } from '../../api/types';
import { AiModelsScreen } from '../ai-models-screen';

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const option = await screen.findByRole('option', { name: optionName });
    fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(option);
}

const MODEL: AiModel = {
    id: 'm-1',
    name: 'Whisper Large v4',
    slug: 'whisper-large-v4',
    description: 'STT fallback',
    category: 'AUDIO',
    taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
    modelType: 'BASE_MODEL',
    source: 'HUGGINGFACE',
    sourceUri: 'openai/whisper-large-v4',
    sourceRevision: null,
    format: 'FASTER_WHISPER',
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 3096,
    computeType: 'float16',
    downloadStatus: 'DOWNLOADED',
    localPath: null,
    downloadedAt: null,
    fileSizeMb: null,
    checksum: null,
    resourceStatus: 'ENABLED',
    version: 4,
    tags: ['stt'],
    tenantId: 't-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
};

function envelope(models: AiModel[]): PaginatedModels {
    return { data: models, total: models.length, page: 0, limit: 25, totalPages: models.length ? 1 : 0 };
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
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({
                url,
                method,
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            // Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved
            // layout in tests. Answered before the handler so it never trips list branches.
            if (url.includes('/user/me/settings')) return method === 'GET' ? Response.json([]) : Response.json({ ok: true });
            return handler(url, method);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('AiModelsScreen', () => {
    it('renders the loaded rows with slug, provider, status and updated cells', async () => {
        stubFetch(() => Response.json(envelope([MODEL])));
        renderWithProviders(<AiModelsScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeDefined();
        expect(await screen.findByText('Whisper Large v4')).toBeDefined();
        expect(screen.getByText('whisper-large-v4')).toBeDefined();
        expect(screen.getByText('Hugging Face')).toBeDefined();
        expect(screen.getByText('Active')).toBeDefined();
        expect(screen.getByRole('grid', { name: 'AI models' })).toBeDefined();
    });

    it('renders the runtime provider badge and architecture', async () => {
        stubFetch(() => Response.json(envelope([MODEL])));
        renderWithProviders(<AiModelsScreen />);

        expect(await screen.findByText('built-in')).toBeDefined();
        expect(screen.getByText('whisper')).toBeDefined();
    });

    it('registers a model with the runtime provider and architecture fields', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST') return Response.json({ ...MODEL, id: 'm-2' });
            return Response.json(envelope([]));
        });
        renderWithProviders(<AiModelsScreen />);
        await screen.findByText('No models registered yet');

        fireEvent.click(screen.getAllByRole('button', { name: 'Register model' })[0]);
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Gemma 4 E2B QAT' } });
        fireEvent.change(within(dialog).getByLabelText(/^slug/i), { target: { value: 'lms-gemma-4-e2b-it-qat' } });
        fireEvent.change(within(dialog).getByLabelText(/^task type/i), { target: { value: 'TEXT_GENERATION' } });
        fireEvent.change(within(dialog).getByLabelText(/^source uri/i), { target: { value: 'gemma-4-e2b-it-qat' } });
        await selectOption(within(dialog).getByLabelText(/^runtime provider/i), 'lm-studio');
        fireEvent.change(within(dialog).getByLabelText(/^architecture/i), { target: { value: 'gemma4' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Register model' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.body).toMatchObject({
            slug: 'lms-gemma-4-e2b-it-qat',
            provider: 'lm-studio',
            architecture: 'gemma4',
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('renders the capability badges on a single line so the fixed-height row keeps its border', async () => {
        stubFetch(() => Response.json(envelope([MODEL])));
        renderWithProviders(<AiModelsScreen />);

        const taskBadge = await screen.findByText('automatic speech recognition');
        const container = taskBadge.parentElement as HTMLElement;
        expect(within(container).getByText('audio')).toBeDefined();
        // A wrapping container grows past the 48px virtual row and paints over border-b.
        expect(container.className).not.toContain('flex-wrap');
    });

    it('mirrors the loaded layout with skeletons while the list is in flight', () => {
        stubFetch(() => new Promise<Response>(() => {}));
        const { container } = renderWithProviders(<AiModelsScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByText('Whisper Large v4')).toBeNull();
    });

    it('shows the neutral empty state with a register CTA when no models exist', async () => {
        stubFetch(() => Response.json(envelope([])));
        renderWithProviders(<AiModelsScreen />);

        expect(await screen.findByText('No models registered yet')).toBeDefined();
        // Header action + empty-state CTA both open the register sheet.
        expect(screen.getAllByRole('button', { name: 'Register model' }).length).toBeGreaterThanOrEqual(2);
    });

    it('surfaces a block error with retry and refetches the list', async () => {
        let attempts = 0;
        stubFetch(() => {
            attempts += 1;
            return attempts === 1
                ? Response.json({ message: 'Service Unavailable' }, { status: 503 })
                : Response.json(envelope([MODEL]));
        });
        renderWithProviders(<AiModelsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('Service Unavailable')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByText('Whisper Large v4')).toBeDefined();
    });

    it('registers a model by POSTing the form payload', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'POST') return Response.json({ ...MODEL, id: 'm-2' });
            return Response.json(envelope([]));
        });
        renderWithProviders(<AiModelsScreen />);
        await screen.findByText('No models registered yet');

        fireEvent.click(screen.getAllByRole('button', { name: 'Register model' })[0]);
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'PhoBERT Med NER' } });
        fireEvent.change(within(dialog).getByLabelText(/^slug/i), { target: { value: 'phobert-med-ner-v2' } });
        fireEvent.change(within(dialog).getByLabelText(/^task type/i), { target: { value: 'TOKEN_CLASSIFICATION' } });
        fireEvent.change(within(dialog).getByLabelText(/^source uri/i), { target: { value: 'arcaai/phobert-med-ner' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Register model' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toBe('/api/hope/admin/ai-models');
        expect(post?.body).toEqual({
            name: 'PhoBERT Med NER',
            slug: 'phobert-med-ner-v2',
            category: 'UNKNOWN',
            taskType: 'TOKEN_CLASSIFICATION',
            modelType: 'BASE_MODEL',
            source: 'HUGGINGFACE',
            sourceUri: 'arcaai/phobert-med-ner',
            format: 'SAFETENSOR',
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('edits a model with an If-Match PATCH derived from the read ETag', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'PATCH') {
                return Response.json({ ...MODEL, name: 'Whisper Large v5', version: 5 }, { headers: { etag: '"5"' } });
            }
            if (url === '/api/hope/admin/ai-models/m-1') return Response.json(MODEL, { headers: { etag: '"4"' } });
            return Response.json(envelope([MODEL]));
        });
        renderWithProviders(<AiModelsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit Whisper Large v4' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByDisplayValue('Whisper Large v4');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Whisper Large v5' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.url).toBe('/api/hope/admin/ai-models/m-1');
        expect(patch?.headers.get('if-match')).toBe('"4"');
        expect(patch?.body).toMatchObject({ name: 'Whisper Large v5', expectedVersion: 4 });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('shows the OCC conflict alert when the PATCH returns 412', async () => {
        stubFetch((url, method) => {
            if (method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
            if (url === '/api/hope/admin/ai-models/m-1') return Response.json(MODEL, { headers: { etag: '"4"' } });
            return Response.json(envelope([MODEL]));
        });
        renderWithProviders(<AiModelsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit Whisper Large v4' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByDisplayValue('Whisper Large v4');
        fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Whisper Large v5' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
        // The sheet stays open so local edits are not lost.
        expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('deletes a model only after the destructive confirm', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'DELETE') return new Response(null, { status: 204 });
            return Response.json(envelope([MODEL]));
        });
        renderWithProviders(<AiModelsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Delete Whisper Large v4' }));
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getAllByText(/whisper large v4/i).length).toBeGreaterThan(0);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
        expect(calls.find((call) => call.method === 'DELETE')?.url).toBe('/api/hope/admin/ai-models/m-1');
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });
});

// =============================================================================
// The hub header action opening the discovery drawer
// =============================================================================
describe('AiModelsScreen discovery action', () => {
    it('renders a "Discover from servers" header action', async () => {
        stubFetch(() => Response.json(envelope([MODEL])));
        renderWithProviders(<AiModelsScreen />);

        await screen.findByText('Whisper Large v4');
        expect(screen.getByRole('button', { name: /discover from servers/i })).toBeDefined();
    });

    it('opens the discovery drawer, which probes the discovery route', async () => {
        const calls = stubFetch((url) => {
            if (url.includes('/discovery')) {
                return Response.json({ entries: [], probes: [], probedAt: '2026-07-20T10:00:00.000Z' });
            }
            return Response.json(envelope([MODEL]));
        });
        renderWithProviders(<AiModelsScreen />);
        await screen.findByText('Whisper Large v4');

        fireEvent.click(screen.getByRole('button', { name: /discover from servers/i }));

        await waitFor(() => expect(calls.some((call) => call.url.includes('admin/ai-models/discovery'))).toBe(true));
        expect(await screen.findByText(/no models found on any server/i)).toBeDefined();
    });

    it('does NOT probe discovery on page load — probes are lazy (drawer open only)', async () => {
        const calls = stubFetch(() => Response.json(envelope([MODEL])));
        renderWithProviders(<AiModelsScreen />);

        await screen.findByText('Whisper Large v4');
        expect(calls.some((call) => call.url.includes('/discovery'))).toBe(false);
    });
});
