/**
 * ModelSourceFetcherService — scheme dispatch over `AiModel.sourceUri`
 * (HuggingFace repo id, or an existing `s3://` prefix) into a flat list of
 * STAGED, sha256-stamped files (TASK-1019 D-3: every file lands in the job's
 * staging directory; nothing is returned as a Buffer).
 * `HuggingFaceModelSourceClient` and `IS3Service` are mocked; no real
 * network/MinIO I/O. The staging directory is a real temp dir.
 *
 * `fetch()` takes `AiModel.source` as its FIRST argument (TASK-960 D1): a
 * `LOCAL` row's weights are expected already staged under the bucket mount,
 * so it must be refused before any scheme dispatch runs — a `LOCAL` row whose
 * `sourceUri` happens to be `org/repo`-shaped must never reach the
 * HuggingFace client (that used to produce a misleading HTTP 401, since the
 * repo does not exist on the Hub).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiModelSource } from '@arcaai/domains';
import { ModelSourceFetcherService } from '../model-source-fetcher.service';
import { STAGING_SPACE_INSUFFICIENT } from '../model-publisher.errors';
import { sha256Hex } from '../model-version.util';

const mockHfClient = { listRepoFiles: vi.fn(), downloadFileTo: vi.fn() };
const mockS3Service = { listFiles: vi.fn(), getFile: vi.fn() };
const freeSpace = vi.fn();

/** A `downloadFileTo` double that writes `content(path)` to disk the way the real client does. */
function writesFiles(content: (path: string) => string = (path) => path) {
  return async (_repo: string, path: string, _revision: string, dest: string, onBytes?: (n: number) => void) => {
    const body = Buffer.from(content(path));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
    onBytes?.(body.length);
    return { size: body.length, sha256: sha256Hex(body) };
  };
}

describe('ModelSourceFetcherService', () => {
  let service: ModelSourceFetcherService;
  let stagingDir: string;
  const opts = () => ({ stagingDir });

  beforeEach(async () => {
    vi.clearAllMocks();
    freeSpace.mockResolvedValue(Number.MAX_SAFE_INTEGER);
    mockHfClient.downloadFileTo.mockImplementation(writesFiles());
    stagingDir = await mkdtemp(join(tmpdir(), 'fetcher-test-'));
    service = new ModelSourceFetcherService(mockHfClient as never, mockS3Service as never, freeSpace);
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  describe('LOCAL sources', () => {
    it('refuses to fetch — before any scheme dispatch — even when sourceUri is org/repo-shaped', async () => {
      await expect(service.fetch(AiModelSource.LOCAL, 'org/repo', null, opts())).rejects.toThrow(/mnt\/models-bucket/);

      expect(mockHfClient.listRepoFiles).not.toHaveBeenCalled();
      expect(mockHfClient.downloadFileTo).not.toHaveBeenCalled();
      expect(mockS3Service.listFiles).not.toHaveBeenCalled();
      expect(mockS3Service.getFile).not.toHaveBeenCalled();
    });

    it('never mentions credentials or tokens — the HF 401 the old dispatch produced was never the right diagnosis', async () => {
      await expect(service.fetch(AiModelSource.LOCAL, 'hf:org/repo', null, opts())).rejects.not.toThrow(/token|credential/i);
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

      const files = await service.fetch(AiModelSource.HUGGINGFACE, 'google/gemma-4-e2b-it-qat-q4_0-gguf', null, opts());

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model-q4_0.gguf', 'tokenizer.json']);
      expect(mockHfClient.downloadFileTo).toHaveBeenCalledTimes(3);
      for (const file of files) {
        expect(file.localPath).toBe(join(stagingDir, file.path));
        const onDisk = await readFile(file.localPath);
        expect(file.sha256).toBe(sha256Hex(onDisk));
        expect(file.size).toBe(onDisk.length);
        expect(file).not.toHaveProperty('data');
      }
    });

    it('accepts the `hf:` scheme prefix identically to a bare org/repo id', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'model.gguf', size: 1 }]);

      await service.fetch(AiModelSource.HUGGINGFACE, 'hf:google/gemma-4-e2b-it-qat-q4_0-gguf', null, opts());

      expect(mockHfClient.listRepoFiles).toHaveBeenCalledWith('google/gemma-4-e2b-it-qat-q4_0-gguf', 'main');
    });

    it('filters GGUF files to a quant substring when one is supplied, but keeps companions regardless', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([
        { path: 'model-Q4_K_M.gguf', size: 1 },
        { path: 'model-Q5_K_M.gguf', size: 1 },
        { path: 'model-mmproj.gguf', size: 1 },
        { path: 'config.json', size: 1 },
      ]);

      const files = await service.fetch(AiModelSource.HUGGINGFACE, 'org/multi-quant-gguf', 'Q4_K_M', opts());

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-mmproj.gguf']);
    });

    it('throws when nothing in the repo matches', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'README.md', size: 1 }]);
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/empty-repo', null, opts())).rejects.toThrow();
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

      const files = await service.fetch(AiModelSource.S3, 's3://hope-models/qwen3-4b-awq/v1/', null, opts());

      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(['config.json', 'model.gguf']);
      expect(mockS3Service.listFiles).toHaveBeenCalledWith('hope-models', 'qwen3-4b-awq/v1/');
      const model = files.find((f) => f.path === 'model.gguf')!;
      expect((await readFile(model.localPath)).toString('utf8')).toBe('qwen3-4b-awq/v1/model.gguf');
      expect(model.sha256).toBe(sha256Hex('qwen3-4b-awq/v1/model.gguf'));
    });
  });

  describe('unsupported sources', () => {
    it('rejects file:// and any other scheme rather than silently falling back', async () => {
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'file:///opt/models/x', null, opts())).rejects.toThrow();
      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'azure-blob://container/prefix', null, opts())).rejects.toThrow();
    });
  });
  describe('staging (TASK-1019 D-3)', () => {
    it('P3 — streams each Hub file into the staging dir at the requested revision and reports bytes', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([
        { path: 'onnx/model.onnx', size: 15 },
        { path: 'config.json', size: 11 },
      ]);
      const onBytes = vi.fn();
      const onPlanned = vi.fn();

      const files = await service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, { stagingDir, revision: 'abc123', onBytes, onPlanned });

      expect(mockHfClient.listRepoFiles).toHaveBeenCalledWith('org/repo', 'abc123');
      expect(mockHfClient.downloadFileTo).toHaveBeenCalledWith('org/repo', 'onnx/model.onnx', 'abc123', join(stagingDir, 'onnx/model.onnx'), onBytes);
      expect(onPlanned).toHaveBeenCalledWith(26);
      expect(onBytes).toHaveBeenCalledTimes(2);
      expect(files.map((f) => f.localPath)).toEqual([join(stagingDir, 'onnx/model.onnx'), join(stagingDir, 'config.json')]);
    });

    it('P4 — refuses STAGING_SPACE_INSUFFICIENT when the files exceed the free space, before downloading anything', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([
        { path: 'model.safetensors', size: 900 },
        { path: 'config.json', size: 200 },
      ]);
      freeSpace.mockResolvedValue(1000);

      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, opts())).rejects.toMatchObject({ code: STAGING_SPACE_INSUFFICIENT });

      expect(freeSpace).toHaveBeenCalledWith(stagingDir);
      expect(mockHfClient.downloadFileTo).not.toHaveBeenCalled();
    });

    it('P4 — proceeds when the files fit exactly', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: 'model.gguf', size: 1000 }]);
      freeSpace.mockResolvedValue(1000);

      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, opts())).resolves.toHaveLength(1);
    });

    it('refuses a source path that would escape the staging dir', async () => {
      mockHfClient.listRepoFiles.mockResolvedValue([{ path: '../escape/model.gguf', size: 1 }]);

      await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, opts())).rejects.toThrow(/staging/);
      expect(mockHfClient.downloadFileTo).not.toHaveBeenCalled();
    });
  });
});
