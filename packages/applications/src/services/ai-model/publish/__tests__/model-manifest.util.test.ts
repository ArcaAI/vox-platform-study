/**
 * `manifest.json` — the Merkle-root record published alongside a model's
 * weights (`infrastructure/docker/minio/README.md` Only the fields
 * derivable from the `AiModel` row + the fetched file set are populated;
 * `contextLength` / `engine.minVersion` / `license` / upstream revision have
 * no source in this lane's inputs and are deliberately omitted rather than
 * guessed.
 */
import { describe, expect, it } from 'vitest';
import { buildAiModelManifest } from '../model-manifest.util';

describe('buildAiModelManifest', () => {
  const files = [
    { path: 'model-q4_0.gguf', sha256: 'aaa', data: Buffer.alloc(100) },
    { path: 'model-mmproj.gguf', sha256: 'bbb', data: Buffer.alloc(50) },
    { path: 'config.json', sha256: 'ccc', data: Buffer.alloc(5) },
  ];

  it('assigns roles by filename (weights / projector / config)', () => {
    const manifest = buildAiModelManifest({
      slug: 'gemma4-e2b-it-qat',
      version: 'q4-0-451faffb5a16',
      quant: 'q4-0',
      format: 'GGUF',
      sourceUri: 'google/gemma-4-e2b-it-qat-q4_0-gguf',
      files,
      publishedBy: 'user-1',
    });

    expect(manifest.objects.find((o) => o.path === 'model-q4_0.gguf')?.role).toBe('weights');
    expect(manifest.objects.find((o) => o.path === 'model-mmproj.gguf')?.role).toBe('projector');
    expect(manifest.objects.find((o) => o.path === 'config.json')?.role).toBe('config');
  });

  it('records primaryObject/projectorObject/shardCount/totalBytes', () => {
    const manifest = buildAiModelManifest({
      slug: 'gemma4-e2b-it-qat',
      version: 'q4-0-451faffb5a16',
      quant: 'q4-0',
      format: 'GGUF',
      sourceUri: 'google/gemma-4-e2b-it-qat-q4_0-gguf',
      files,
      publishedBy: 'user-1',
    });

    expect(manifest.primaryObject).toBe('model-q4_0.gguf');
    expect(manifest.projectorObject).toBe('model-mmproj.gguf');
    expect(manifest.shardCount).toBe(1);
    expect(manifest.totalBytes).toBe(155);
  });

  it('carries slug/version/quantization/format/upstream/publishedBy through verbatim', () => {
    const manifest = buildAiModelManifest({
      slug: 'gemma4-e2b-it-qat',
      version: 'q4-0-451faffb5a16',
      quant: 'q4-0',
      format: 'GGUF',
      sourceUri: 'google/gemma-4-e2b-it-qat-q4_0-gguf',
      files,
      publishedBy: 'user-1',
    });

    expect(manifest.slug).toBe('gemma4-e2b-it-qat');
    expect(manifest.version).toBe('q4-0-451faffb5a16');
    expect(manifest.quantization).toBe('q4-0');
    expect(manifest.format).toBe('GGUF');
    expect(manifest.upstream).toEqual({ sourceUri: 'google/gemma-4-e2b-it-qat-q4_0-gguf' });
    expect(manifest.publishedBy).toBe('user-1');
    expect(typeof manifest.publishedAt).toBe('string');
  });

  it('is null-quantization safe (non-GGUF single-artifact source)', () => {
    const manifest = buildAiModelManifest({
      slug: 'text-embedding-x',
      version: '451faffb5a16',
      quant: null,
      format: 'SAFETENSOR',
      sourceUri: 's3://hope-models/text-embedding-x/v1/',
      files: [{ path: 'model.safetensors', sha256: 'zzz', data: Buffer.alloc(10) }],
      publishedBy: 'user-1',
    });

    expect(manifest.quantization).toBeNull();
    expect(manifest.projectorObject).toBeNull();
    expect(manifest.primaryObject).toBe('model.safetensors');
  });
});
