import { ModelTaskType } from '@arcaai/domains';

const LM_STUDIO_PROVIDERS: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio']);
const EMBEDDING_TASKS: ReadonlySet<string> = new Set([ModelTaskType.FEATURE_EXTRACTION, ModelTaskType.SENTENCE_SIMILARITY]);

/**
 * The id LM Studio answers to for a GGUF published at `<bucketDir>/<version>/` — derived exactly as
 * the cluster's `link-models` init container names it (deployment repo `base/lmstudio.yaml`): the
 * directory with its `-gguf` suffix and any `text-embedding-` prefix stripped, plus the
 * `text-embedding-` prefix LM Studio itself prepends for an embedding model. Seed precedent:
 * `gemma-4-e2b-it-qat-gguf/` → `gemma-4-e2b-it-qat`.
 *
 * `null` for any provider other than LM Studio — its wire id is not derivable from the bucket.
 */
export function lmStudioWireModelId(provider: string | null | undefined, bucketDir: string, taskType: string | null | undefined): string | null {
  if (!provider || !LM_STUDIO_PROVIDERS.has(provider)) return null;
  const model = bucketDir
    .replace(/\/+$/, '')
    .replace(/-gguf$/, '')
    .replace(/^text-embedding-/, '');
  if (!model) return null;
  return taskType && EMBEDDING_TASKS.has(taskType) ? `text-embedding-${model}` : model;
}
