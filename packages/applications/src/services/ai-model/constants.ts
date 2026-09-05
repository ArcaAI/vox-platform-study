import { ModelTaskType } from '@arcaai/domains';

/**
 * Model-registry vocabularies (TASK-860). Declared ONCE here for the
 * application + API layers; `packages/database/.../seed/ai-models/shared.ts`
 * carries a mirror because that package is a dependency leaf and cannot import
 * this one. Parity between the two is pinned by
 * `tests/contracts/ai-model-providers.contract.test.ts`.
 */

/**
 * Canonical runtime provider ids for registry rows (`AiModel.provider`).
 *
 * `ollama` is selectable with no platform-seeded catalog rows — the provider
 * logic stays, the model catalog went (owner decision 2026-08-17).
 */
export const AI_MODEL_PROVIDERS = [
  'ollama',
  'lm-studio',
  'azure',
  'bedrock',
  'built-in',
  'sarvam',
  'openai',
  // Cloud tenant-BYO ASR vendors — distinct from the LLM-plane `azure` above
  // (different resource, different credential, different residency posture).
  // `CLOUD_BYO_PROVIDERS.stt` names these two; a catalogue row that said
  // `azure` instead resolved no BYO credential at all (TASK-888).
  'azure-speech',
  'azure-foundry',
  // Cloud tenant-BYO LLM providers.
  'anthropic',
  'vertex',
  // Production self-host engines (OpenAI-compatible `/v1` wire).
  'vllm',
  'llama-cpp',
] as const;

/**
 * The subset of providers whose models live on a server we can
 * ENUMERATE (`admin/ai-models/discovery`). Cloud providers have nothing to
 * "discover".
 */
export const DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama', 'lm-studio', 'vllm', 'llama-cpp'] as const;

/**
 * The serving-library vocabulary (`AiModel.libraryName`) — the Hugging Face
 * Hub's `library_name` facet, restricted to what this platform can load. It
 * replaces the overloaded `format` + `provider` pair for loader selection.
 */
export const AI_MODEL_LIBRARIES = [
  // Self-hosted — apps/stt
  'faster-whisper',
  'whisper.cpp',
  'ctranslate2',
  'parakeet.cpp',
  'nemo',
  'onnxruntime',
  'pyrnnoise',
  'deepfilternet',
  'speechbrain',
  'pyannote-audio',
  'cadence-punctuation',
  // Self-hosted — apps/nlp / apps/tts / shared
  'transformers',
  'gliner2',
  'llama.cpp',
  'kokoro',
  'parler-tts',
  // Engine hosts (OpenAI-compatible `/v1`)
  'lm-studio',
  'ollama',
  'vllm',
  // Cloud vendors
  'azure-speech',
  'azure-foundry',
  'azure-openai',
  'openai',
  'sarvam',
  'bedrock',
  'anthropic',
  'vertex',
] as const;

export type AiModelLibrary = (typeof AI_MODEL_LIBRARIES)[number];

/**
 * The workload that executes a registry row (`AiModel.servedBy`). Cloud rows
 * are GOVERNED by the gateway (credentials, cascade — TASK-862) and EXECUTED
 * by the owning service, so they name that service, not the gateway.
 */
export const AI_MODEL_SERVED_BY = ['stt', 'stt-worker', 'nlp', 'tts', 'tts-worker', 'lmstudio', 'text', 'gateway-proxy'] as const;

export type AiModelServedBy = (typeof AI_MODEL_SERVED_BY)[number];

/**
 * Libraries whose loaders read a Hugging Face HUB CACHE directory
 * (`hf/hub/models--<org>--<repo>/snapshots/<sha>/…`) rather than a flat
 * `<slug>/<version>/` prefix. The publisher lays these out as a verbatim HF
 * cache (README §3.3) so `HF_HOME=/mnt/models-bucket/hf` + `HF_HUB_OFFLINE=1`
 * serves them without any per-library path plumbing.
 */
export const HF_CACHE_LIBRARIES: ReadonlySet<string> = new Set<AiModelLibrary>([
  'transformers',
  'gliner2',
  'speechbrain',
  'pyannote-audio',
  'kokoro',
  'parler-tts',
  'cadence-punctuation',
]);

/**
 * `AiModel.taskType` → the Hugging Face `pipeline_tag` (kebab-case). The
 * Prisma/TS identifier stays `taskType` (parallel-safety deviation 1 of the
 * TASK-860 brief); the DTO derives `pipelineTag` from this table.
 *
 * The three HOPE extensions map onto the nearest Hub tag: the two diarization
 * members are audio-classification heads; `GUARDRAIL` types the granite-guardian
 * screen, which the Hub tags `text-generation` (it is an LLM).
 */
export const MODEL_TASK_TYPE_TO_PIPELINE_TAG: Record<ModelTaskType, string> = Object.values(ModelTaskType).reduce(
  (acc, taskType) => {
    acc[taskType] = taskType.toLowerCase().replace(/_/g, '-');
    return acc;
  },
  {
    [ModelTaskType.GUARDRAIL]: 'text-generation',
    [ModelTaskType.SPEAKER_DIARIZATION]: 'audio-classification',
    [ModelTaskType.SPEAKER_EMBEDDING]: 'audio-classification',
    [ModelTaskType.UNKNOWN]: 'other',
  } as Record<ModelTaskType, string>,
);

/**
 * The `hope-models` bucket — see `infrastructure/docker/minio/README.md`.
 * A bucket name, not tenant/environment config: every other consumer of this
 * bucket (STT's `StoragePathResolver`, harness) hardcodes the same literal, and
 * MinIO credentials/endpoint — the part that actually varies per environment —
 * resolve through the existing `IS3Service`, never a new env var here.
 */
export const HOPE_MODELS_BUCKET = 'hope-models';

/** Mount point of the s3fs sidecar that serves `hope-models` inside every serving pod. */
export const HOPE_MODELS_MOUNT = '/mnt/models-bucket';

/**
 * `localPath` is DERIVED (TASK-860 D-2): the mount + the bucket prefix, plus
 * the primary object for single-file loaders (whisper.cpp, llama.cpp). Never
 * an operator free-text field — the create/update DTOs reject it.
 */
export function deriveLocalPath(bucketPrefix: string, primaryObject?: string | null): string {
  const prefix = bucketPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const base = `${HOPE_MODELS_MOUNT}/${prefix}/`;
  return primaryObject ? `${base}${primaryObject.replace(/^\/+/, '')}` : base;
}
