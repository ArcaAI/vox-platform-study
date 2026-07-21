/**
 * @arcaai/vox - LocalVoiceEmbedder
 *
 * In-browser speaker-embedding extractor backed by Transformers.js (ONNX). It
 * loads a small, permissively-licensed speaker-verification model and turns a
 * mic/uploaded audio clip into a fixed-length speaker embedding entirely on the
 * client — no audio ever leaves the browser for the LOCAL provider.
 *
 * Default model: `Xenova/wavlm-base-plus-sv` — Microsoft WavLM-Base-Plus with
 * an X-Vector head fine-tuned on VoxCeleb1 (MIT-licensed upstream), re-hosted
 * with ONNX weights for Transformers.js. It emits a 512-dim embedding; cosine
 * similarity of two embeddings is the speaker-verification score.
 *
 * Runtime/caching: mirrors the established `@arcaai/med-ner` pattern — the heavy
 * `@huggingface/transformers` module is **dynamically imported** (so it stays a
 * lazy chunk) and `env.useBrowserCache = true` caches the PUBLIC HF-hub weights
 * in the shared `transformers-cache` Cache Storage bucket (per `08-vox-sdk.mdc`:
 * public weights are identical across tenants and stay on the shared cache;
 * only tenant-CUSTOM weights would be namespaced). The extracted EMBEDDINGS are
 * tenant/user-namespaced by the consuming hook, not here.
 *
 * The transformers module and the audio decoder are injectable so unit tests
 * run without downloading weights or touching an AudioContext.
 */

/** Default LOCAL model: WavLM-Base-Plus speaker-verification (X-Vector head). */
export const DEFAULT_LOCAL_VOICE_MODEL_ID = 'Xenova/wavlm-base-plus-sv';

/** Embedding dimensionality emitted by the default WavLM `*-sv` x-vector head. */
export const LOCAL_VOICE_EMBEDDING_DIM = 512;

/** Sample rate the model expects (WavLM is pretrained on 16 kHz speech). */
export const LOCAL_VOICE_SAMPLE_RATE = 16_000;

export interface LocalVoiceEmbedderProgress {
  status: 'downloading' | 'ready';
  file?: string;
  /** 0–100 (Transformers.js convention) when available. */
  progress?: number;
  loaded?: number;
  total?: number;
}

export type LocalVoiceProgressCallback = (progress: LocalVoiceEmbedderProgress) => void;

/** Minimal structural shape of the bits of Transformers.js we depend on. */
interface TransformersLike {
  AutoProcessor: {
    from_pretrained: (modelId: string, options?: Record<string, unknown>) => Promise<TransformersCallable>;
  };
  AutoModel: {
    from_pretrained: (modelId: string, options?: Record<string, unknown>) => Promise<TransformersCallable>;
  };
  env: Record<string, unknown>;
}

type TransformersCallable = (input: unknown) => Promise<unknown>;

interface EmbeddingTensorLike {
  data: ArrayLike<number>;
  dims?: number[];
}

export interface CreateLocalVoiceEmbedderOptions {
  /** HF-hub model id. Defaults to {@link DEFAULT_LOCAL_VOICE_MODEL_ID}. */
  modelId?: string;
  /** Transformers.js dtype for the ONNX model. `fp32` keeps embedding fidelity. */
  dtype?: string;
  /** Injectable for tests; defaults to a dynamic `import('@huggingface/transformers')`. */
  transformersLoader?: () => Promise<TransformersLike>;
  /** Injectable for tests; defaults to a 16 kHz mono Web Audio decode. */
  decodeAudio?: (blob: Blob) => Promise<Float32Array>;
}

export interface LocalVoiceEmbedder {
  readonly modelId: string;
  /** Load the processor + model once (idempotent). Streams download progress. */
  load(onProgress?: LocalVoiceProgressCallback): Promise<void>;
  /** Extract a speaker embedding from already-decoded 16 kHz mono samples. */
  embed(audio: Float32Array): Promise<number[]>;
  /** Decode an audio Blob/File then extract its speaker embedding. */
  embedBlob(blob: Blob, onProgress?: LocalVoiceProgressCallback): Promise<number[]>;
  /** Release the loaded model so the next call reloads from cache. */
  dispose(): void;
}

/**
 * Whether the current environment can run the LOCAL in-browser embedder. The
 * ONNX runtime needs WebAssembly; decoding needs an (Offline)AudioContext.
 */
export function isLocalVoiceEmbeddingSupported(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof g.OfflineAudioContext !== 'undefined' || typeof g.webkitOfflineAudioContext !== 'undefined';
}

/**
 * Default 16 kHz mono decoder: decode the compressed clip with an AudioContext,
 * down-mix to mono, and resample to 16 kHz via an OfflineAudioContext render.
 */
async function defaultDecodeAudio(blob: Blob): Promise<Float32Array> {
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const AudioCtor = g.AudioContext ?? g.webkitAudioContext;
  const OfflineCtor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!AudioCtor || !OfflineCtor) {
    throw new Error('LocalVoiceEmbedder: Web Audio API is unavailable in this environment');
  }

  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await decodeCtx.close();
  }

  const frameCount = Math.ceil((decoded.duration || 0) * LOCAL_VOICE_SAMPLE_RATE) || decoded.length;
  const offline = new OfflineCtor(1, frameCount, LOCAL_VOICE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function normalizeProgress(raw: unknown): LocalVoiceEmbedderProgress | null {
  const data = raw as { status?: string; file?: string; progress?: number; loaded?: number; total?: number };
  if (!data || typeof data !== 'object') return null;
  return {
    status: 'downloading',
    file: data.file,
    progress: data.progress,
    loaded: data.loaded,
    total: data.total,
  };
}

/**
 * Create a LOCAL voice embedder. The model is loaded lazily on first use and
 * reused across calls; inject `transformersLoader`/`decodeAudio` in tests.
 */
export function createLocalVoiceEmbedder(options: CreateLocalVoiceEmbedderOptions = {}): LocalVoiceEmbedder {
  const modelId = options.modelId ?? DEFAULT_LOCAL_VOICE_MODEL_ID;
  const dtype = options.dtype ?? 'fp32';
  const loadTransformers = options.transformersLoader ?? (() => import('@huggingface/transformers') as Promise<TransformersLike>);
  const decodeAudio = options.decodeAudio ?? defaultDecodeAudio;

  let processor: TransformersCallable | null = null;
  let model: TransformersCallable | null = null;
  let loadPromise: Promise<void> | null = null;

  async function doLoad(onProgress?: LocalVoiceProgressCallback): Promise<void> {
    const transformers = await loadTransformers();

    // Public HF-hub weights → shared `transformers-cache` (08-vox-sdk.mdc).
    transformers.env.allowLocalModels = false;
    transformers.env.useBrowserCache = true;

    const progress_callback = onProgress
      ? (raw: unknown) => {
          const normalized = normalizeProgress(raw);
          if (normalized) onProgress(normalized);
        }
      : undefined;

    processor = await transformers.AutoProcessor.from_pretrained(modelId, { progress_callback });
    model = await transformers.AutoModel.from_pretrained(modelId, { dtype, progress_callback });

    onProgress?.({ status: 'ready' });
  }

  async function ensureLoaded(onProgress?: LocalVoiceProgressCallback): Promise<void> {
    if (processor && model) return;
    if (!loadPromise) {
      loadPromise = doLoad(onProgress).catch((err) => {
        // Allow a later retry after a failed load.
        loadPromise = null;
        throw err;
      });
    }
    await loadPromise;
  }

  return {
    modelId,

    async load(onProgress?: LocalVoiceProgressCallback): Promise<void> {
      await ensureLoaded(onProgress);
    },

    async embed(audio: Float32Array): Promise<number[]> {
      await ensureLoaded();
      if (!processor || !model) {
        throw new Error('LocalVoiceEmbedder: model failed to initialize');
      }
      const inputs = await processor(audio);
      const output = (await model(inputs)) as { embeddings?: EmbeddingTensorLike };
      const tensor = output?.embeddings;
      if (!tensor || !tensor.data || tensor.data.length === 0) {
        throw new Error('LocalVoiceEmbedder: model did not return a speaker embedding');
      }
      return Array.from(tensor.data as ArrayLike<number>);
    },

    async embedBlob(blob: Blob, onProgress?: LocalVoiceProgressCallback): Promise<number[]> {
      await ensureLoaded(onProgress);
      const audio = await decodeAudio(blob);
      return this.embed(audio);
    },

    dispose(): void {
      processor = null;
      model = null;
      loadPromise = null;
    },
  };
}
