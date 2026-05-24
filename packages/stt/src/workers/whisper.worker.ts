/**
 * @arcaai/stt - Whisper WebWorker
 *
 * Runs Whisper ML inference in a dedicated Web Worker to avoid blocking the main thread.
 * This allows the UI to remain responsive during transcription.
 *
 * Communication Protocol:
 * - Main → Worker: { type: 'init' | 'transcribe' | 'destroy' | 'check-cache', payload: ... }
 * - Worker → Main: { type: 'ready' | 'progress' | 'result' | 'error' | 'cache-status', payload: ... }
 */

// Worker message types
interface WorkerMessage {
  type: 'init' | 'transcribe' | 'destroy' | 'check-cache';
  id: string; // Request ID for correlation
  payload: InitPayload | TranscribePayload | CheckCachePayload | null;
}

interface CheckCachePayload {
  modelId: string;
}

interface InitPayload {
  modelId: string;
  device: 'webgpu' | 'wasm' | undefined;
  language: string;
  codeSwitching?: boolean;
  chunkLengthS: number;
  overlapLengthS: number;
  returnTimestamps: boolean | 'word';
}

interface TranscribePayload {
  audio: Float32Array;
  options?: {
    language?: string;
    returnTimestamps?: boolean | 'word';
    /**
     * Initial prompt to bias decoder toward domain vocabulary. Passed to
     * Transformers.js as `initial_prompt` (Whisper's standard prompt-priming
     * mechanism). When omitted, no prompt is forwarded.
     */
    prompt?: string;
    /**
     * TASK-300 L-2: Whisper inference task.
     *
     * - `'transcribe'` (default) — output is in the source language.
     * - `'translate'` — translate from the source language to English.
     *   Multilingual checkpoints only; `.en` models are gated on the main
     *   thread before postMessage.
     */
    task?: 'transcribe' | 'translate';
  };
}

interface WorkerResponse {
  type: 'ready' | 'progress' | 'result' | 'error';
  id: string;
  payload: unknown;
}

// Pipeline instance (lazy loaded)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whisperPipeline: any = null;
let currentConfig: InitPayload | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNumericOnnxError(message: string): boolean {
  return /^\d+$/.test(message.trim());
}

function isWebGpuInitError(message: string): boolean {
  return /no available backend found|backend not found|webgpu/i.test(message);
}

function isCrossAttentionError(message: string): boolean {
  return /cross.attentions|output_attentions/i.test(message);
}

/**
 * TASK-300 L-9: resolve ONNX Runtime WASM thread count.
 *
 * Returns `navigator.hardwareConcurrency` (clamped to 8) when the worker is
 * running in a cross-origin-isolated context — the only time
 * SharedArrayBuffer is available for ORT's threaded inference. Returns `1`
 * otherwise, including legacy environments where `crossOriginIsolated` is
 * undefined or `hardwareConcurrency` is missing.
 *
 * Cross-origin isolation requires the host page to ship:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * See packages/stt/README.md → "Multi-threaded ONNX Runtime (COOP/COEP)".
 */
const MAX_ORT_THREADS = 8;
function resolveOrtNumThreads(): number {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  const hwConcurrency = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
  if (typeof hwConcurrency !== 'number' || !Number.isFinite(hwConcurrency) || hwConcurrency < 2) return 1;
  return Math.min(MAX_ORT_THREADS, Math.floor(hwConcurrency));
}

async function clearOnnxCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') {
      return;
    }
    const keys = await caches.keys();
    for (const key of keys) {
      if (key.includes('transformers') || key.includes('onnx')) {
        await caches.delete(key);
      }
    }
  } catch {
    // Cache API may not be available in all worker contexts
  }
}

/**
 * Send a message to the main thread.
 */
function postResponse(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * Initialize the Whisper pipeline.
 */
async function initPipeline(id: string, payload: InitPayload): Promise<void> {
  if (whisperPipeline && currentConfig && currentConfig.modelId === payload.modelId) {
    currentConfig = { ...payload, device: currentConfig.device };
    postResponse({
      type: 'ready',
      id,
      payload: { status: 'ready', progress: 1, device: currentConfig.device },
    });
    return;
  }

  try {
    // Report loading start
    postResponse({
      type: 'progress',
      id,
      payload: { status: 'loading', progress: 0, file: payload.modelId },
    });

    const { pipeline, env } = await import('@huggingface/transformers');

    // Enable browser cache (Cache API) for model files so they persist across sessions.
    env.useBrowserCache = true;
    env.useCustomCache = false;
    env.allowLocalModels = false;

    // ONNX Runtime WASM configuration for Web Worker context.
    //
    // The bundled onnxruntime-web JS glue code must load a matching WASM binary at
    // runtime. transformers.js defaults wasmPaths to its own CDN dist/ which packages
    // the correct WASM files for its pinned onnxruntime-web version.
    //
    // Additionally:
    // - proxy=false: we're already in a worker; spawning a sub-worker would fail
    // - numThreads: TASK-300 L-9 — opt into multi-threaded WASM when the host
    //   page is cross-origin-isolated. SharedArrayBuffer (required for ORT
    //   threaded inference) is only available when both COOP and COEP response
    //   headers are set; without isolation we MUST stay at 1 or ORT crashes
    //   immediately. We additionally clamp `hardwareConcurrency` at 8 because
    //   ORT's thread pool sees diminishing returns past that point for Whisper
    //   inference and can starve the rest of the page on big CPUs.
    type OnnxWasmEnv = { proxy?: boolean; numThreads?: number; wasmPaths?: string };
    type OnnxEnv = { wasm?: OnnxWasmEnv; webgpu?: Record<string, unknown> };
    const onnxEnv = (env as Record<string, unknown>).backends as { onnx?: OnnxEnv } | undefined;
    if (onnxEnv?.onnx?.wasm) {
      const wasmCfg = onnxEnv.onnx.wasm;
      wasmCfg.proxy = false;
      wasmCfg.numThreads = resolveOrtNumThreads();
    }

    const progressCallback = (progressData: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
      if (progressData.status === 'progress' && progressData.progress !== undefined) {
        postResponse({
          type: 'progress',
          id,
          payload: {
            status: 'downloading',
            progress: progressData.progress / 100,
            file: progressData.file,
            loaded: progressData.loaded,
            total: progressData.total,
          },
        });
      } else if (progressData.status === 'done') {
        postResponse({
          type: 'progress',
          id,
          payload: { status: 'loading', progress: 1, file: progressData.file },
        });
      }
    };

    const buildPipelineOptions = (device: 'webgpu' | 'wasm') => {
      const normalizedDevice: 'webgpu' | undefined = device === 'webgpu' ? 'webgpu' : undefined;
      // fp16 for WebGPU (faster, lower VRAM), default precision for WASM.
      const dtype = device === 'webgpu' ? { encoder_model: 'fp16' as const, decoder_model_merged: 'fp16' as const } : undefined;
      return {
        device: normalizedDevice,
        dtype,
        progress_callback: progressCallback,
      };
    };

    const createPipelineWithRetry = async (device: 'webgpu' | 'wasm') => {
      const options = buildPipelineOptions(device);
      try {
        return await pipeline('automatic-speech-recognition', payload.modelId, options);
      } catch (firstError) {
        const msg = getErrorMessage(firstError);
        if (!isNumericOnnxError(msg)) {
          throw firstError;
        }

        postResponse({
          type: 'progress',
          id,
          payload: {
            status: 'loading',
            progress: 0,
            file: `Retrying with fresh cache (ONNX error ${msg})`,
          },
        });

        await clearOnnxCaches();

        return pipeline('automatic-speech-recognition', payload.modelId, options);
      }
    };

    let actualDevice: 'webgpu' | 'wasm' = payload.device === 'webgpu' ? 'webgpu' : 'wasm';

    try {
      whisperPipeline = await createPipelineWithRetry(actualDevice);
    } catch (error) {
      const msg = getErrorMessage(error);
      const shouldFallbackToWasm = actualDevice === 'webgpu' && (isWebGpuInitError(msg) || isNumericOnnxError(msg));

      if (!shouldFallbackToWasm) {
        throw error;
      }

      postResponse({
        type: 'progress',
        id,
        payload: {
          status: 'loading',
          progress: 0,
          file: 'WebGPU initialization failed, falling back to WASM',
        },
      });

      actualDevice = 'wasm';
      whisperPipeline = await createPipelineWithRetry(actualDevice);
    }

    currentConfig = {
      ...payload,
      device: actualDevice,
    };

    postResponse({
      type: 'ready',
      id,
      payload: { status: 'ready', progress: 1, device: actualDevice },
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);

    postResponse({
      type: 'error',
      id,
      payload: {
        message: rawMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

/**
 * Transcribe audio using the loaded pipeline.
 */
async function transcribe(id: string, payload: TranscribePayload): Promise<void> {
  if (!whisperPipeline || !currentConfig) {
    postResponse({
      type: 'error',
      id,
      payload: { message: 'Pipeline not initialized. Call init first.' },
    });
    return;
  }

  const startTime = performance.now();

  try {
    const { audio, options } = payload;
    const language = options?.language ?? currentConfig.language;
    const returnTimestamps = options?.returnTimestamps ?? currentConfig.returnTimestamps;

    // English-only models (.en suffix) reject `language` and `task` parameters.
    // Only pass language for multilingual models.
    const isEnglishOnlyModel = currentConfig.modelId.endsWith('.en');
    const allowAutoLanguage = currentConfig.codeSwitching || language.toLowerCase() === 'auto';

    const transcribeOptions: Record<string, unknown> = {
      return_timestamps: returnTimestamps,
    };

    if (!isEnglishOnlyModel && !allowAutoLanguage) {
      transcribeOptions.language = language;
    }

    // Add chunking for longer audio
    if (audio.length > currentConfig.chunkLengthS * 16000) {
      transcribeOptions.chunk_length_s = currentConfig.chunkLengthS;
      transcribeOptions.stride_length_s = currentConfig.overlapLengthS;
    }

    // Forward optional initial prompt to suppress hallucinations on
    // domain-specific vocabulary.
    if (options?.prompt !== undefined && options.prompt !== '') {
      transcribeOptions.initial_prompt = options.prompt;
    }

    // TASK-300 L-2: forward Whisper `task` when explicitly requested.
    // English-only checkpoints are gated upstream in WhisperWorkerEngine so
    // we never reach here with `task === 'translate'` on a `.en` model.
    if (options?.task !== undefined && !isEnglishOnlyModel) {
      transcribeOptions.task = options.task;
    }

    type PipelineResult = {
      text: string;
      chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
    };

    let result: PipelineResult;
    try {
      result = (await whisperPipeline(audio, transcribeOptions)) as PipelineResult;
    } catch (pipelineError) {
      const msg = getErrorMessage(pipelineError);
      if (returnTimestamps === 'word' && isCrossAttentionError(msg)) {
        // The ONNX model lacks cross-attention outputs required for word-level
        // timestamps (needs export with output_attentions=True). Fall back to
        // chunk-level timestamps so transcription still succeeds.
        transcribeOptions.return_timestamps = true;
        result = (await whisperPipeline(audio, transcribeOptions)) as PipelineResult;
      } else {
        throw pipelineError;
      }
    }

    const latencyMs = performance.now() - startTime;

    let timestamps: Array<{ start: number; end: number; text: string }> | undefined;
    if (result.chunks && result.chunks.length > 0) {
      timestamps = result.chunks.map((chunk) => ({
        start: chunk.timestamp[0],
        end: chunk.timestamp[1] ?? chunk.timestamp[0],
        text: chunk.text,
      }));
    }

    postResponse({
      type: 'result',
      id,
      payload: {
        text: result.text.trim(),
        isFinal: true,
        language,
        timestamps,
        duration: audio.length / 16000,
        latencyMs,
      },
    });
  } catch (error) {
    postResponse({
      type: 'error',
      id,
      payload: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

/**
 * Destroy the pipeline and release resources.
 */
function destroyPipeline(id: string): void {
  whisperPipeline = null;
  currentConfig = null;

  postResponse({
    type: 'ready',
    id,
    payload: { status: 'destroyed' },
  });
}

/**
 * Check if a model's files are present in the browser Cache API.
 * Returns { cached: boolean, files: number } so the UI can show cache status.
 */
async function checkModelCache(id: string, payload: CheckCachePayload): Promise<void> {
  try {
    let cachedFileCount = 0;
    const cacheKeys = await caches.keys();
    for (const key of cacheKeys) {
      if (key.includes('transformers')) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        cachedFileCount += requests.filter((r) => r.url.includes(payload.modelId.replace('/', '%2F')) || r.url.includes(payload.modelId)).length;
      }
    }

    postResponse({
      type: 'result',
      id,
      payload: { cached: cachedFileCount > 0, files: cachedFileCount },
    });
  } catch {
    postResponse({
      type: 'result',
      id,
      payload: { cached: false, files: 0 },
    });
  }
}

/**
 * Handle incoming messages from the main thread.
 */
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, id, payload } = event.data;

  switch (type) {
    case 'init':
      await initPipeline(id, payload as InitPayload);
      break;

    case 'transcribe':
      await transcribe(id, payload as TranscribePayload);
      break;

    case 'destroy':
      destroyPipeline(id);
      break;

    case 'check-cache':
      await checkModelCache(id, payload as CheckCachePayload);
      break;

    default:
      postResponse({
        type: 'error',
        id,
        payload: { message: `Unknown message type: ${type}` },
      });
  }
};

// Export empty object for TypeScript module resolution
export {};
