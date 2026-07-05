import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModel, deleteModel, getModel, getModelBySlug, listModels, listModelsPaginated, updateModel } from '../client';
import { aiModelKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

function installFetchMock(response: () => Response): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return response();
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('aiModelKeys', () => {
    it('is stable and distinguishes list vs paginated vs detail', () => {
        expect(aiModelKeys.all()).toEqual(aiModelKeys.all());
        expect(aiModelKeys.list({ page: 1 })).toEqual(aiModelKeys.list({ page: 1 }));
        expect(aiModelKeys.all()).not.toEqual(aiModelKeys.list());
        expect(aiModelKeys.detail('m-1')).not.toEqual(aiModelKeys.bySlug('m-1'));
        expect(aiModelKeys.all()[0]).toBe('ai-models');
    });
});

describe('ai-models client', () => {
    it('parses the CUSTOM paginated envelope { data, total, page, limit, totalPages }', async () => {
        installFetchMock(() => Response.json({ data: [{ id: 'm-1' }], total: 1, page: 1, limit: 20, totalPages: 1 }));
        const result = await listModelsPaginated({ page: 1, limit: 20 });
        expect(result.total).toBe(1);
        expect(result.totalPages).toBe(1);
        expect(result.data[0].id).toBe('m-1');
    });

    it('covers array read, detail, slug and create', async () => {
        const calls = installFetchMock(() => Response.json([]));
        await listModels();
        await getModel('m-1');
        await getModelBySlug('whisper-large-v3');
        await createModel({
            name: 'Whisper',
            slug: 'whisper-large-v3',
            category: 'AUDIO',
            taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
            modelType: 'BASE_MODEL',
            source: 'HUGGINGFACE',
            sourceUri: 'openai/whisper-large-v3',
            format: 'FASTER_WHISPER',
        });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/ai-models',
            'GET /api/hope/admin/ai-models/m-1',
            'GET /api/hope/admin/ai-models/slug/whisper-large-v3',
            'POST /api/hope/admin/ai-models',
        ]);
    });

    it('PATCHes with If-Match + expectedVersion and deletes', async () => {
        const calls = installFetchMock(() => Response.json({ id: 'm-1', version: 5 }, { headers: { etag: '"5"' } }));
        await updateModel('m-1', { description: 'updated' }, '"4"');
        await deleteModel('m-1');
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].headers.get('if-match')).toBe('"4"');
        expect(calls[0].body).toEqual({ description: 'updated', expectedVersion: 4 });
        expect(calls[1].method).toBe('DELETE');
    });
});
