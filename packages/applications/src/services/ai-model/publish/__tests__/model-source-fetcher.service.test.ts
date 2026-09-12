/**
 * ModelSourceFetcherService — scheme dispatch over `AiModel.sourceUri`
 * (HuggingFace repo id, or an existing `s3://` prefix) into a flat list of
 * downloaded, sha256-stamped files. `HuggingFaceModelSourceClient` and
 * `IS3Service` are mocked; no real network/MinIO I/O.
 *
 * `fetch()` takes `AiModel.source` as its FIRST argument (TASK-960 D1): a
 * `LOCAL` row's weights are expected already staged under the bucket mount,
 * so it must be refused before any scheme dispatch runs — a `LOCAL` row whose
 * `sourceUri` happens to be `org/repo`-shaped must never reach the
 * HuggingFace client (that used to produce a misleading HTTP 401, since the
 * repo does not exist on the Hub).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiModelSource } from '@arcaai/domains';
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

  describe('LOCAL sources', () => {
    it('refuses to fetch — before any scheme dispatch — even when sourceUri is org/repo-shaped', async () => {
      await expect(service.fetch(AiModelSource.LOCAL, 'org/repo', null)).rejects.toThrow(/mnt\/models-bucket/);

      expect(mockHfClient.listRepoFiles).not.toHaveBeenCalled();
      expect(mockHfClient.downloadFile).not.toHaveBeenCalled();
      expect(mockS3Service.listFiles).not.toHaveBeenCalled();
      expect(mockS3Service.getFile).not.toHaveBeenCalled();
    });

    it('never mentions credentials or tokens — the HF 401 the old dispatch produced was never the right diagnosis', async () => {
      await expect(service.fetch(AiModelSource.LOCAL, 'hf:org/repo', null)).rejects.not.toThrow(/token|credential/i);
    });
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

      const files = await service.fetch(AiModelSource.HUGGINGFACE, 'google/gemma-4-e2b-it-qat-q4_0-gguf', null);

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

      await service.fetch(AiModelSource.HUGGINGFACE, 'hf:google/gemma-4-e2b-it-qat-q4_0-gguf', null);

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

      const files = await service.fetch(AiModelSource.HUGGINGFACE, 'org/multi-quant-gguf', 'Q4_K_M');

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-mmproj.gguf']);
    });

    it('throws when nothing in the repo matches', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'README.md', size: 1 }]);
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/empty-repo', null)).rejects.toThrow();
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

      const files = await service.fetch(AiModelSource.S3, 's3://hope-models/qwen3-4b-awq/v1/', null);

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model.gguf']);
      expect(mockS3Service.listFiles).toHaveBeenCalledWith('hope-models', 'qwen3-4b-awq/v1/');
    });
  });

  describe('unsupported sources', () => {
    it('rejects file:// and any other scheme rather than silently falling back', async () => {
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'file:///opt/models/x', null)).rejects.toThrow();
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'azure-blob://container/prefix', null)).rejects.toThrow();
    });
  });
});
