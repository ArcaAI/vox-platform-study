import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
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

/**
 * `bucketPrefix` must be RELATIVE to the `hope-models` bucket root, never
 * bucket-qualified (TASK-960 D2): `HOPE_MODELS_MOUNT` already IS that bucket's
 * root inside every serving pod, so a stored value of `hope-models/x` (or an
 * `s3://hope-models/x` URI pasted in from a `sourceUri` field) makes
 * `deriveLocalPath()` produce `/mnt/models-bucket/hope-models/x` — a path
 * that does not exist. Applied to `bucketPrefix` on both `CreateModelRequest`
 * and `UpdateModelRequest` via `@Validate(BucketRelativePrefixConstraint)`.
 *
 * An empty string is deliberately ACCEPTED: it is the documented sentinel the
 * update DTO uses to CLEAR `bucketPrefix` (+ `primaryObject`), not a value to
 * validate as a path. Presence/absence and other shape checks (`@IsString`,
 * `@MaxLength`) are the other decorators' job — this constraint answers only
 * "is this bucket-relative?".
 */
@ValidatorConstraint({ name: 'bucketRelativePrefix', async: false })
export class BucketRelativePrefixConstraint implements ValidatorConstraintInterface {
  /** Ensures a single trailing slash, without asserting anything about validity. */
  static normalize(value: string): string {
    const trimmed = value.replace(/^\/+/, '');
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }

  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value === '') return true;
    if (/^s3:\/\//i.test(value)) return false;
    const normalized = BucketRelativePrefixConstraint.normalize(value);
    return normalized !== `${HOPE_MODELS_BUCKET}/` && !normalized.startsWith(`${HOPE_MODELS_BUCKET}/`);
  }

  defaultMessage(): string {
    return (
      `bucketPrefix must be a path relative to the '${HOPE_MODELS_BUCKET}' bucket root — do not repeat the bucket ` +
      `name or use an 's3://' scheme. The bucket is already mounted at '${HOPE_MODELS_MOUNT}', so a bucket-qualified ` +
      `value resolves to a path that does not exist.`
    );
  }
}

/**
 * The row shape `derivedLocalPath` needs. Structural on purpose: the entity, a
 * `ModelResponse` and a plain projection all satisfy it, and none of them has to
 * import the other.
 */
export interface BucketIdentity {
  bucketPrefix?: string | null;
  primaryObject?: string | null;
  /** Decides whether the derived path names the primary OBJECT or its DIRECTORY. */
  libraryName?: string | null;
}

/**
 * Libraries whose loader opens ONE file, so the derived `localPath` names the
 * primary object rather than the directory holding it.
 *
 * Declared HERE rather than in the publish processor (TASK-890 L1) because the
 * derivation and the publish job must agree by construction: they used to agree
 * only because the job wrote the value into a column every reader then trusted.
 * With the column gone, one shared set is what keeps a multi-file loader from
 * being handed a file path.
 */
export const SINGLE_FILE_LIBRARIES: ReadonlySet<string> = new Set(['whisper.cpp', 'llama.cpp', 'onnxruntime', 'parakeet.cpp']);

/**
 * TASK-890 §3.11 — `localPath` as a DERIVATION, never a column read.
 *
 * The three bookkeeping columns (`downloadStatus`, `downloadedAt`, `fileSizeMb`)
 * and `localPath` itself are dropped by L2. `localPath` survives as a WIRE field
 * on the resolved specs, because `apps/stt` still reads `local_path` as the
 * highest-precedence weight location — so the VALUE must not change, only where
 * it comes from. This function is that "where": the bucket identity, and
 * nothing else. A row with no `bucketPrefix` derives `null`, which is exactly
 * what makes the downstream resolvers fall back to `sourceUri` scheme dispatch.
 *
 * Deliberately does NOT fall back to a stored `localPath` even when one is
 * present: a fallback would keep the column alive in behaviour after L2 removes
 * it in schema, and the two would then disagree silently.
 */
export function derivedLocalPath(row: BucketIdentity | null | undefined): string | null {
  if (!row?.bucketPrefix) return null;
  const singleFile = row.libraryName ? SINGLE_FILE_LIBRARIES.has(row.libraryName) : false;
  return deriveLocalPath(row.bucketPrefix, singleFile ? (row.primaryObject ?? null) : null);
}
