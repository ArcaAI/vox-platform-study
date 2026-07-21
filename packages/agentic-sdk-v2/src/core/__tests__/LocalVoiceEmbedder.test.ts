/**
 * LocalVoiceEmbedder tests.
 *
 * The heavy ONNX model (`@huggingface/transformers` WavLM speaker-verification)
 * is fully MOCKED — no weights are downloaded and nothing touches the network
 * or an AudioContext. We inject a fake transformers module + a fake audio
 * decoder so the embedder's orchestration (load → decode → processor → model →
 * embedding) is exercised deterministically.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createLocalVoiceEmbedder,
  isLocalVoiceEmbeddingSupported,
  DEFAULT_LOCAL_VOICE_MODEL_ID,
  LOCAL_VOICE_EMBEDDING_DIM,
} from '../LocalVoiceEmbedder';

function makeFakeTransformers(embedding: number[]) {
  const processor = vi.fn(async (audio: unknown) => ({ input_values: audio }));
  const model = vi.fn(async () => ({
    embeddings: { data: Float32Array.from(embedding), dims: [1, embedding.length] },
  }));
  const env: Record<string, unknown> = {};
  const AutoProcessor = {
    from_pretrained: vi.fn(async (_id: string, opts?: Record<string, unknown>) => {
      (opts?.progress_callback as ((p: unknown) => void) | undefined)?.({ status: 'progress', file: 'preprocessor_config.json', progress: 100 });
      return processor;
    }),
  };
  const AutoModel = {
    from_pretrained: vi.fn(async (_id: string, opts?: Record<string, unknown>) => {
      (opts?.progress_callback as ((p: unknown) => void) | undefined)?.({ status: 'progress', file: 'model.onnx', progress: 50, loaded: 5, total: 10 });
      return model;
    }),
  };
  return { module: { AutoProcessor, AutoModel, env }, processor, model, AutoProcessor, AutoModel, env };
}

const DIM = 512;
const fakeEmbedding = Array.from({ length: DIM }, (_, i) => (i % 7) - 3);

describe('constants', () => {
  it('defaults to the Xenova WavLM speaker-verification model', () => {
    expect(DEFAULT_LOCAL_VOICE_MODEL_ID).toBe('Xenova/wavlm-base-plus-sv');
  });

  it('documents the 512-dim WavLM x-vector embedding size', () => {
    expect(LOCAL_VOICE_EMBEDDING_DIM).toBe(512);
  });
});

describe('isLocalVoiceEmbeddingSupported', () => {
  it('returns a boolean', () => {
    expect(typeof isLocalVoiceEmbeddingSupported()).toBe('boolean');
  });
});

describe('createLocalVoiceEmbedder', () => {
  it('loads AutoProcessor + AutoModel for the configured model and sets browser-cache env', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1, 0.2]),
    });

    await embedder.load();

    expect(fake.AutoProcessor.from_pretrained).toHaveBeenCalledWith('Xenova/wavlm-base-plus-sv', expect.any(Object));
    expect(fake.AutoModel.from_pretrained).toHaveBeenCalledWith('Xenova/wavlm-base-plus-sv', expect.any(Object));
    // public HF-hub weights → shared transformers cache (per 08-vox-sdk.mdc)
    expect(fake.env.useBrowserCache).toBe(true);
    expect(fake.env.allowLocalModels).toBe(false);
  });

  it('honors a custom model id', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      modelId: 'Xenova/some-other-sv',
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });
    await embedder.load();
    expect(fake.AutoProcessor.from_pretrained).toHaveBeenCalledWith('Xenova/some-other-sv', expect.any(Object));
    expect(embedder.modelId).toBe('Xenova/some-other-sv');
  });

  it('only loads the model once across repeated calls', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });
    await embedder.load();
    await embedder.load();
    await embedder.embed(Float32Array.from([0.1, 0.2]));
    expect(fake.AutoModel.from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('embed() runs processor then model and returns the embedding as a number[]', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });

    const audio = Float32Array.from([0.5, 0.6, 0.7]);
    const out = await embedder.embed(audio);

    expect(fake.processor).toHaveBeenCalledWith(audio);
    expect(fake.model).toHaveBeenCalledTimes(1);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(DIM);
    expect(out).toEqual(fakeEmbedding);
  });

  it('embedBlob() decodes the blob then extracts (auto-loading the model)', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const decoded = Float32Array.from([0.9, 0.8, 0.7, 0.6]);
    const decodeAudio = vi.fn(async () => decoded);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio,
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const out = await embedder.embedBlob(blob);

    expect(decodeAudio).toHaveBeenCalledWith(blob);
    expect(fake.processor).toHaveBeenCalledWith(decoded);
    expect(out).toEqual(fakeEmbedding);
    // auto-loaded
    expect(fake.AutoModel.from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('forwards download progress from both processor and model loads', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });

    const onProgress = vi.fn();
    await embedder.load(onProgress);

    expect(onProgress).toHaveBeenCalled();
    const statuses = onProgress.mock.calls.map((c) => (c[0] as { status?: string }).status);
    expect(statuses).toContain('downloading');
    // a terminal "ready" event is emitted once both artifacts are loaded
    expect(statuses).toContain('ready');
  });

  it('throws a clear error when the model returns no embeddings', async () => {
    const processor = vi.fn(async (audio: unknown) => ({ input_values: audio }));
    const model = vi.fn(async () => ({})); // no `embeddings`
    const module = {
      AutoProcessor: { from_pretrained: vi.fn(async () => processor) },
      AutoModel: { from_pretrained: vi.fn(async () => model) },
      env: {} as Record<string, unknown>,
    };
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });

    await expect(embedder.embed(Float32Array.from([0.1]))).rejects.toThrow(/embedding/i);
  });

  it('dispose() clears the loaded model so a later call reloads', async () => {
    const fake = makeFakeTransformers(fakeEmbedding);
    const embedder = createLocalVoiceEmbedder({
      transformersLoader: async () => fake.module,
      decodeAudio: async () => Float32Array.from([0.1]),
    });
    await embedder.load();
    embedder.dispose();
    await embedder.load();
    expect(fake.AutoModel.from_pretrained).toHaveBeenCalledTimes(2);
  });
});
