/**
 * Retired AI-model slug ledger + pipeline-reference guard.
 *
 * The 50 slugs of the previous 60-row `DEFAULT_AI_MODELS` catalog that the
 * consolidation retires, PLUS 3 more added by the Ollama model-catalog
 * purge, PLUS the 11 rows TASK-860 retires to land on the owner's 35-row
 * catalogue (64 total; soft-`DELETED`, never hard-deleted — recoverable). Note the purge is
 * of CATALOG ROWS ONLY: the `ollama` PROVIDER remains selectable (owner
 * decision 2026-08-17), so these slugs are retired because the platform no
 * longer ships an opinion about which Ollama model to run — not because the
 * engine is gone. `retireLegacyAiModels`
 * (06-stt.ts) sweeps EVERY tenant's copy of each slug, guarded by
 * `shouldRetireAiModelSlug`: a slug still referenced by any non-deleted
 * `AsrPipeline.configYaml` (a tenant may have built a custom pipeline on it)
 * is SKIPPED with a loud warning instead of breaking
 * `config_reader._to_model_config` resolution in stt.
 *
 * NEVER remove a slug from this ledger once added — that un-retires it and
 * leaves any tenant's already-materialised copy pointing at a removed engine.
 */

export const RETIRED_AI_MODEL_SLUGS: readonly string[] = [
  // ASR
  'whisper-large-v3',
  'whisper-medium',
  'faster-whisper-large-v3',
  'parakeet-ctc-1.1b',
  // VAD
  'silero-vad-v4',
  'silero-vad-v5',
  'pyannote-vad',
  // Noise reduction
  'deepfilternet-v3',
  'nvidia-cleanunet',
  // Server-side ONNX whisper
  'whisper-large-v3-turbo-onnx',
  'whisper-large-v3-onnx',
  'whisper-medium-onnx',
  'whisper-small-onnx',
  // Ollama LLMs
  'ollama-qwen3.5-27b',
  'ollama-qwen3.5-latest',
  'ollama-translategemma-12b',
  'ollama-translategemma-latest',
  'ollama-medgemma-27b-text-q4km',
  'ollama-gemma3-latest',
  'ollama-gemma3n-e2b',
  'ollama-gpt-oss-latest',
  'ollama-gemma3n-latest',
  'ollama-granite4-tiny-h',
  'ollama-granite4-latest',
  // Ollama LLMs — Ollama MODEL CATALOG purged; the provider itself
  // stays selectable, owner decision 2026-08-17)
  'ollama-gemma4-12b-mlx',
  'ollama-gemma4-e2b-it-qat',
  'ollama-qwen3.5-2b',
  // Azure OpenAI LLMs
  'gpt-4',
  'gpt-4o',
  'gpt-4o-mini',
  // AWS Bedrock LLMs
  'claude-3-haiku',
  'claude-3.5-sonnet',
  // OpenAI-compatible generic row
  'local-model-openai-compat',
  // LM Studio LLMs
  'lms-qwen3.5-4b',
  'lms-qwen3.5-0.8b',
  'lms-qwen3.5-9b',
  'lms-qwen3.5-35b-a3b',
  'lms-lfm2-24b-a2b',
  'lms-glm-4.6v-flash',
  'lms-lfm2.5-1.2b-instruct',
  'lms-lfm2.5-1.2b-thinking',
  'lms-lfm2.5-vl-1.6b',
  'lms-translategemma-27b-it',
  'lms-gemma-4-e2b-it-sft-rlvr-medical',
  'lms-medgemma-1.5-4b-unsloth',
  'lms-gpt-oss-20b',
  // Browser-local whisper (SDK lists are hardcoded — safe to retire)
  'whisper-tiny',
  'whisper-base',
  'whisper-small-local',
  'whisper-medium-local',
  'whisper-tiny-en',
  'whisper-base-en',
  'whisper-small-en',
  // TASK-860 — not in the owner's 35-row catalogue (README §2.5). The three
  // whisper rows are still referenced by seeded ASR pipeline YAML, so the
  // pipeline-reference guard SKIPS them on an existing database until
  // TASK-861 retires the pipeline surface; a fresh seed never creates them.
  'whisper-small',
  'whisper-large-v3-turbo',
  'whisper-large-v3-turbo-gguf',
  'lms-gemma-4-12b-qat',
  'lms-medgemma-1.5-4b-it',
  'lms-medgemma-1.5-4b-it-vision',
  'vllm-medgemma-1.5-27b-it',
  'llama-cpp-medgemma-1.5-4b-it',
  'bedrock-claude-3.5-haiku',
  'nlp-doc-type-classifier',
  'indic-f5',
  // Owner catalogue revision (33 rows): the e2e ASR fixture row and the two
  // surplus LM Studio rows. `lms-gemma-4-e4b-it-qat` is retired as a SLUG only —
  // its weights (the QAT q4_0 GGUF) live on under `lms-gemma-4-e4b`, which took
  // over that row's identity; the un-quantised bf16 build it displaced is gone.
  'whisper-large-v3-turbo-q8_0',
  'lms-gemma-4-e4b-it-qat',
  'lms-gemma-4-medical-icd10',
  // TASK-966 — replaced by `cadence-fast` (80000000-…-0004-000000000002): the slug named the
  // legacy `cadence-punctuation` wrapper path, which cannot load under transformers 5.x, so
  // every seeded ASR agent bound to it ran unpunctuated. The seeded agents now bind
  // `cadence-fast`, the exact name the stt punctuation service routes to its direct loader.
  'cadence-punctuation',
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Characters that may legally appear INSIDE a slug / model identifier. An
 * occurrence only counts as a reference when it is NOT flanked by these, so:
 *   - `asr: "whisper-large-v3"` → references `whisper-large-v3`
 *   - `asr: "whisper-large-v3-turbo"` → does NOT reference `whisper-large-v3`
 *   - `hf_model_id: "openai/whisper-tiny"` → does NOT reference the `whisper-tiny`
 *     slug (path segment of an inline hf id, not a registry slug reference)
 * A plain substring check would permanently block the retirement of
 * `whisper-large-v3` / `faster-whisper-large-v3` (prefixes of keeper slugs
 * referenced by every seeded pipeline), defeating the consolidation.
 */
const SLUG_BOUNDARY_CHARSET = '[A-Za-z0-9._/-]';

/** True when the pipeline YAML references the slug as a standalone identifier. */
export const pipelineYamlReferencesSlug = (configYaml: string, slug: string): boolean =>
  new RegExp(`(?<!${SLUG_BOUNDARY_CHARSET})${escapeRegExp(slug)}(?!${SLUG_BOUNDARY_CHARSET})`).test(configYaml);

/**
 * Pure retirement decision for one slug (exported for testability):
 * retire (true) only when NO non-deleted pipeline YAML references it;
 * a referenced slug must be skipped (false) by the sweep.
 */
export const shouldRetireAiModelSlug = (slug: string, activePipelineYamls: readonly string[]): boolean =>
  !activePipelineYamls.some((yaml) => pipelineYamlReferencesSlug(yaml, slug));
