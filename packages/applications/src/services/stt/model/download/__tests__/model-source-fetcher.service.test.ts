/**
 * ModelSourceFetcherService — scheme dispatch over `AiModel.sourceUri`
 * (HuggingFace repo id, or an existing `s3://` prefix) into a flat list of
 * downloaded, sha256-stamped files. `HuggingFaceModelSourceClient` and
 * `IS3Service` are mocked; no real network/MinIO I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelSourceFetcherService } from '../model-source-fetcher.service';
import { sha256Hex } from '../model-version.util';

const mockHfClient = { listRepoFiles: vi.fn(), downloadFile: vi.fn() };
const mockS3Service = { listFiles: vi.fn(), getFile: vi.fn() };

describe('ModelSourceFetcherService', () => {
  let service: ModelSourceFetcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ModelSourceFetcherService(mockHfClient as never, mockS3Service as never);
  });

  describe('HuggingFace sources', () => {
    it('downloads only the relevant files (gguf + known companions), skipping README/license/etc', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([
        { path: 'model-q4_0.gguf', size: 100 },
        { path: 'config.json', size: 10 },
        { path: 'tokenizer.json', size: 20 },
        { path: 'README.md', size: 5 },
        { path: '.gitattributes', size: 1 },
      ]);
      mockHfClient.downloadFile.mockImplementation(async (_repo: string, path: string) => Buffer.from(path));

      const files = await service.fetch('google/gemma-4-e2b-it-qat-q4_0-gguf', null);

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model-q4_0.gguf', 'tokenizer.json']);
      expect(mockHfClient.downloadFile).toHaveBeenCalledTimes(3);
      for (const file of files) {
        expect(file.sha256).toBe(sha256Hex(file.data));
      }
    });

    it('accepts the `hf:` scheme prefix identically to a bare org/repo id', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'model.gguf', size: 1 }]);
      mockHfClient.downloadFile.mockResolvedValue(Buffer.from('x'));

      await service.fetch('hf:google/gemma-4-e2b-it-qat-q4_0-gguf', null);

      expect(mockHfClient.listRepoFiles).toHaveBeenCalledWith('google/gemma-4-e2b-it-qat-q4_0-gguf');
    });

    it('filters GGUF files to a quant substring when one is supplied, but keeps companions regardless', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([
        { path: 'model-Q4_K_M.gguf', size: 1 },
        { path: 'model-Q5_K_M.gguf', size: 1 },
        { path: 'model-mmproj.gguf', size: 1 },
        { path: 'config.json', size: 1 },
      ]);
      mockHfClient.downloadFile.mockImplementation(async (_repo: string, path: string) => Buffer.from(path));

      const files = await service.fetch('org/multi-quant-gguf', 'Q4_K_M');

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-mmproj.gguf']);
    });

    it('throws when nothing in the repo matches', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'README.md', size: 1 }]);
      await expect(service.fetch('org/empty-repo', null)).rejects.toThrow();
    });
  });

  describe('s3:// sources', () => {
    it('lists and downloads every relevant object under the prefix, using the key relative to the prefix as `path`', async () => {
      mockS3Service.listFiles.mockResolvedValue([
        { key: 'qwen3-4b-awq/v1/model.gguf', size: 100 },
        { key: 'qwen3-4b-awq/v1/config.json', size: 10 },
        { key: 'qwen3-4b-awq/v1/README.md', size: 1 },
      ]);
      mockS3Service.getFile.mockImplementation(async (_bucket: string, key: string) => Buffer.from(key));

      const files = await service.fetch('s3://hope-models/qwen3-4b-awq/v1/', null);

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model.gguf']);
      expect(mockS3Service.listFiles).toHaveBeenCalledWith('hope-models', 'qwen3-4b-awq/v1/');
    });
  });

  describe('unsupported sources', () => {
    it('rejects file:// and any other scheme rather than silently falling back', async () => {
      await expect(service.fetch('file:///opt/models/x', null)).rejects.toThrow();
      await expect(service.fetch('azure-blob://container/prefix', null)).rejects.toThrow();
    });
  });
});
