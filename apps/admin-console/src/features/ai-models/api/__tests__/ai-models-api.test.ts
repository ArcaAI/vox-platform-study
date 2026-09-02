import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createModel,
  deleteModel,
  discoverModels,
  getModel,
  getModelBySlug,
  getModelDownloadState,
  getModelRegistryConnectionStatus,
  listModels,
  listModelsPaginated,
  registerDiscoveredModel,
  startModelDownload,
  updateModel,
} from '../client';
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

// =============================================================================
// Discovery client + query keys
// =============================================================================
describe('discovery client', () => {
  it('GETs admin/ai-models/discovery and passes the provider filter', async () => {
    const calls = installFetchMock(() => Response.json({ entries: [], probes: [], probedAt: '2026-07-20T10:00:00.000Z' }));

    await discoverModels();
    await discoverModels('lm-studio');

    expect(calls[0].url).toContain('admin/ai-models/discovery');
    expect(calls[0].method).toBe('GET');
    expect(calls[1].url).toContain('provider=lm-studio');
  });

  it('POSTs the register body to admin/ai-models/discovery/register', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'm-9', slug: 'mistral-7b' }));

    await registerDiscoveredModel({ provider: 'ollama', modelName: 'mistral:7b' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('admin/ai-models/discovery/register');
    expect(calls[0].body).toEqual({ provider: 'ollama', modelName: 'mistral:7b' });
  });

  it('keys discovery per provider filter and under the ai-models root', () => {
    expect(aiModelKeys.discovery()).not.toEqual(aiModelKeys.discovery('ollama'));
    expect(aiModelKeys.discovery()[0]).toBe('ai-models');
    expect(aiModelKeys.discovery()).not.toEqual(aiModelKeys.all());
  });
});

// =============================================================================
// Download client — FROZEN contract (TASK-855)
// =============================================================================
describe('download client', () => {
  it('POSTs :id/download with no body and returns the 202 job envelope', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'job-1', status: 'DOWNLOADING' }, { status: 202 }));

    const result = await startModelDownload('m-1');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/admin/ai-models/m-1/download');
    expect(calls[0].body).toBeUndefined();
    expect(result).toEqual({ jobId: 'job-1', status: 'DOWNLOADING' });
  });

  it('GETs :id/download for the polled job state', async () => {
    const calls = installFetchMock(() =>
      Response.json({ status: 'DOWNLOADED', fileSizeMb: 512, sha256: 'abc', localPath: '/mnt/models-bucket/m/v/', finishedAt: '2026-09-01T00:00:00.000Z' }),
    );

    const result = await getModelDownloadState('m-1');

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/api/hope/admin/ai-models/m-1/download');
    expect(result.status).toBe('DOWNLOADED');
    expect(result.fileSizeMb).toBe(512);
  });

  it('surfaces a 409 (already in flight) as a GatewayError', async () => {
    installFetchMock(() => Response.json({ message: 'A download is already running for this model.' }, { status: 409 }));

    await expect(startModelDownload('m-1')).rejects.toMatchObject({ status: 409 });
  });

  it('keys the download poll per model id, under the ai-models root', () => {
    expect(aiModelKeys.download('m-1')).not.toEqual(aiModelKeys.download('m-2'));
    expect(aiModelKeys.download('m-1')[0]).toBe('ai-models');
  });
});

// =============================================================================
// Model-registry connection status — read-only, pinned to the SYSTEM tenant
// =============================================================================
describe('model-registry connection status client', () => {
  it('GETs admin/providers/model-registry/s3 pinned to the SYSTEM tenant', async () => {
    const calls = installFetchMock(() => Response.json({ enabled: true, hasKey: true, version: 3 }));

    const result = await getModelRegistryConnectionStatus();

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('admin/providers/model-registry/s3');
    expect(calls[0].url).toContain('tenantId=00000000-0000-0000-0000-000000000000');
    expect(result).toEqual({ enabled: true, hasKey: true, version: 3 });
  });
});
