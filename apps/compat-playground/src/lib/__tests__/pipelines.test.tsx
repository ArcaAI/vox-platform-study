import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPipelines } from '../pipelines';

// Named `.test.tsx` (not `.test.ts`) even though it renders nothing — the
// component-test vitest config only collects `src/**/*.test.tsx`
// (`vitest.config.ts`), mirroring `SummaryCard.test.tsx`'s convention.

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROW = { id: 'p1', name: 'Default STT', slug: 'default-stt', isDefault: true };

describe('fetchPipelines', () => {
  it('unwraps a bare array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [ROW] }));

    const options = await fetchPipelines('http://localhost:8868', 'key');

    expect(options).toEqual([{ id: 'p1', value: 'p1', label: 'Default STT (default-stt)', isDefault: true }]);
  });

  it.each(['data', 'items', 'results'] as const)('unwraps the %s envelope key', async (key) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ [key]: [ROW] }) }));

    const options = await fetchPipelines('http://localhost:8868', 'key');

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('p1');
  });

  it('falls back to the slug, then the id, when name is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'p2', slug: 'no-name-pipeline', isDefault: false },
          { id: 'p3', isDefault: false },
        ],
      }),
    );

    const options = await fetchPipelines('http://localhost:8868', 'key');

    expect(options).toEqual([
      { id: 'p2', value: 'p2', label: 'no-name-pipeline', isDefault: false },
      { id: 'p3', value: 'p3', label: 'p3', isDefault: false },
    ]);
  });

  it('drops rows with no usable id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [{ name: 'No id here' }, ROW] }));

    const options = await fetchPipelines('http://localhost:8868', 'key');

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('p1');
  });

  it('returns an empty list for an unrecognized envelope shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: 'shape' }) }));

    const options = await fetchPipelines('http://localhost:8868', 'key');

    expect(options).toEqual([]);
  });

  it('rejects on a non-OK response so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    await expect(fetchPipelines('http://localhost:8868', 'key')).rejects.toThrow('HTTP 403');
  });

  it('rejects on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchPipelines('http://localhost:8868', 'key')).rejects.toThrow('network down');
  });

  it('tolerates a trailing slash on apiEndpoint and sends x-api-key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    await fetchPipelines('http://localhost:8868/', 'my-key').catch(() => {});

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8868/api/v1/audio/pipelines',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'my-key' }) }),
    );
  });
});
