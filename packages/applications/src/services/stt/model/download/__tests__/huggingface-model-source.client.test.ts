/**
 * HuggingFaceModelSourceClient — thin transport wrapper over the HF Hub
 * REST surface. No real network I/O in this suite; `HttpService.axiosRef`
 * is mocked, matching `KnowledgeIngestClient`'s test convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HuggingFaceModelSourceClient } from '../huggingface-model-source.client';

describe('HuggingFaceModelSourceClient', () => {
  const axiosRef = { get: vi.fn() };
  let client: HuggingFaceModelSourceClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HuggingFaceModelSourceClient({ axiosRef } as never);
  });

  describe('listRepoFiles', () => {
    it('requests the recursive tree endpoint and returns only file entries', async () => {
      axiosRef.get.mockResolvedValue({
        data: [
          { path: 'config.json', type: 'file', size: 512 },
          { path: 'weights', type: 'directory' },
          { path: 'model.gguf', type: 'file', lfs: { size: 3350000000 } },
        ],
      });

      const files = await client.listRepoFiles('google/gemma-4-e2b-it-qat-q4_0-gguf');

      expect(axiosRef.get).toHaveBeenCalledWith(
        'https://huggingface.co/api/models/google/gemma-4-e2b-it-qat-q4_0-gguf/tree/main?recursive=1',
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(files).toEqual([
        { path: 'config.json', size: 512 },
        { path: 'model.gguf', size: 3350000000 },
      ]);
    });

    it('returns an empty list when the API responds with something unexpected', async () => {
      axiosRef.get.mockResolvedValue({ data: { error: 'not found' } });
      const files = await client.listRepoFiles('missing/repo');
      expect(files).toEqual([]);
    });
  });

  describe('downloadFile', () => {
    it('GETs the resolve URL as an arraybuffer and returns a Buffer', async () => {
      axiosRef.get.mockResolvedValue({ data: new TextEncoder().encode('hello').buffer });

      const result = await client.downloadFile('google/gemma-4-e2b-it-qat-q4_0-gguf', 'config.json');

      expect(axiosRef.get).toHaveBeenCalledWith(
        'https://huggingface.co/google/gemma-4-e2b-it-qat-q4_0-gguf/resolve/main/config.json',
        expect.objectContaining({ responseType: 'arraybuffer' }),
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString('utf8')).toBe('hello');
    });
  });
});
