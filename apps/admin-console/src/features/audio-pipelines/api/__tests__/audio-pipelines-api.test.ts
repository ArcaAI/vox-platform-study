import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    assignPipelineTenant,
    createPipeline,
    deletePipeline,
    getPipeline,
    getPipelineBySlug,
    getPipelineVersion,
    listPipelineVersions,
    listPipelines,
    listPipelinesPage,
    setDefaultPipeline,
    togglePipeline,
    updatePipeline,
    validatePipelineConfig,
} from '../client';
import { audioPipelineKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
    ifMatch: string | null;
}

function installFetchMock(): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
                ifMatch: headers.get('if-match'),
            });
            return Response.json({ success: true }, { headers: { etag: '"8"' } });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('audioPipelineKeys', () => {
    it('is stable and separates list, detail and versions', () => {
        expect(audioPipelineKeys.list()).toEqual(audioPipelineKeys.list());
        expect(audioPipelineKeys.detail('p-1')).toEqual(audioPipelineKeys.detail('p-1'));
        expect(audioPipelineKeys.detail('p-1')).not.toEqual(audioPipelineKeys.detail('p-2'));
        expect(audioPipelineKeys.versions('p-1')).not.toEqual(audioPipelineKeys.detail('p-1'));
        expect(audioPipelineKeys.versions('p-1')[0]).toBe('audio-pipelines');
    });
});

describe('audio pipelines client', () => {
    it('covers list, paginated list, detail, slug lookup and versions reads', async () => {
        const calls = installFetchMock();
        await listPipelines();
        await listPipelinesPage({ page: 1, limit: 20 });
        await getPipeline('p-1');
        await getPipelineBySlug('fast-clin-vi');
        await listPipelineVersions('p-1');
        await getPipelineVersion('p-1', 12);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/audio/pipelines',
            'GET /api/hope/admin/audio/pipelines/list?page=1&limit=20',
            'GET /api/hope/admin/audio/pipelines/p-1',
            'GET /api/hope/admin/audio/pipelines/slug/fast-clin-vi',
            'GET /api/hope/admin/audio/pipelines/p-1/versions',
            'GET /api/hope/admin/audio/pipelines/p-1/versions/12',
        ]);
    });

    it('keeps the ETag from the detail read for the later If-Match PATCH', async () => {
        installFetchMock();
        const detail = await getPipeline('p-1');
        expect(detail.etag).toBe('"8"');
    });

    it('creates, validates (preflight), assigns tenant and sets the default', async () => {
        const calls = installFetchMock();
        await createPipeline({ name: 'Fast Clinical VI', slug: 'fast-clin-vi', configYaml: 'version: "1.0"' });
        await validatePipelineConfig('version: "1.0"');
        await assignPipelineTenant('p-1', 'tnt-2');
        await setDefaultPipeline('p-1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/hope/admin/audio/pipelines',
            'POST /api/hope/admin/audio/pipelines/validate',
            'POST /api/hope/admin/audio/pipelines/p-1/assign-tenant',
            'POST /api/hope/admin/audio/pipelines/p-1/set-default',
        ]);
        expect(calls[0].body).toEqual({ name: 'Fast Clinical VI', slug: 'fast-clin-vi', configYaml: 'version: "1.0"' });
        expect(calls[1].body).toEqual({ configYaml: 'version: "1.0"' });
        expect(calls[2].body).toEqual({ tenantId: 'tnt-2' });
    });

    it('sends If-Match + body expectedVersion on update, If-Match only on toggle, and deletes', async () => {
        const calls = installFetchMock();
        await updatePipeline('p-1', { configYaml: 'version: "2.0"' }, '"7"');
        await togglePipeline('p-1', false, '"7"');
        await deletePipeline('p-1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'PATCH /api/hope/admin/audio/pipelines/p-1',
            'PATCH /api/hope/admin/audio/pipelines/p-1/toggle',
            'DELETE /api/hope/admin/audio/pipelines/p-1',
        ]);
        expect(calls[0].ifMatch).toBe('"7"');
        expect(calls[0].body).toEqual({ configYaml: 'version: "2.0"', expectedVersion: 7 });
        expect(calls[1].ifMatch).toBe('"7"');
        // TogglePipelineRequest declares `enabled` only — the strict gateway
        // ValidationPipe (forbidNonWhitelisted) rejects any extra field.
        expect(calls[1].body).toEqual({ enabled: false });
        expect(calls[2].ifMatch).toBeNull();
    });
});
