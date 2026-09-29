import { parseAiModelAsrProfile, SERVING_COMPUTE_TYPES, type ResolvedServingSpec, type ServingComputeType, type ServingKind } from '@arcaai/types';
import type { AiModelEntity } from '@arcaai/domains';
import { derivedLocalPath } from '../constants';

/**
 * TASK-1021 (C-1 / C-2) — why a row cannot be served, named on the 409 `MODEL_NOT_SERVABLE`.
 * A FROZEN vocabulary: `apps/vllm` maps it verbatim.
 */
export type ServingSpecRefusal = 'FORMAT_UNSUPPORTED' | 'SERVING_FACTS_MISSING' | 'DISABLED';

export type BuildResolvedServingSpecResult = { ok: true; spec: ResolvedServingSpec } | { ok: false; reason: ServingSpecRefusal };

/**
 * `AiModel.taskType` → the engine family `apps/vllm` builds. A task outside this table has no
 * vLLM engine, which is a refusal of the row's FORMAT for serving, not a missing fact.
 */
const TASK_TYPE_TO_KIND: Readonly<Record<string, ServingKind>> = Object.freeze({
  AUTOMATIC_SPEECH_RECOGNITION: 'asr',
  TEXT_GENERATION: 'llm',
  TEXT_TO_SPEECH: 'tts',
});

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The engine sizing facts on `AiModel._metadata.serving` (D-11). `vramGiB` is REQUIRED and
 * fails closed — it sizes a GPU — while the two optional knobs fall back to the engine default
 * (`null`) when absent or malformed.
 */
function readEngine(metaData: unknown): ResolvedServingSpec['engine'] | null {
  const serving = isRec(metaData) ? metaData.serving : undefined;
  if (!isRec(serving)) return null;
  const { vramGiB, maxNumSeqs, enforceEager } = serving;
  if (typeof vramGiB !== 'number' || !Number.isFinite(vramGiB) || vramGiB <= 0) return null;
  return {
    vramGiB,
    maxNumSeqs: typeof maxNumSeqs === 'number' && Number.isInteger(maxNumSeqs) && maxNumSeqs >= 1 ? maxNumSeqs : null,
    enforceEager: typeof enforceEager === 'boolean' ? enforceEager : null,
  };
}

/**
 * ONE `AiModel` row → the engine-build contract, or the named reason it cannot be served.
 *
 * Pure on purpose: WHICH row (tenant first, then SYSTEM) is the service's decision; this only
 * reads the row it is handed.
 */
export function buildResolvedServingSpec(row: AiModelEntity): BuildResolvedServingSpecResult {
  if (row.resourceStatus !== 'ENABLED') return { ok: false, reason: 'DISABLED' };

  const kind = TASK_TYPE_TO_KIND[row.taskType];
  if (row.format !== 'SAFETENSOR' || !kind) return { ok: false, reason: 'FORMAT_UNSUPPORTED' };

  const engine = readEngine(row.metaData);
  if (!engine) return { ok: false, reason: 'SERVING_FACTS_MISSING' };

  // `quantization` / `maxModelLen` stay on `_metadata.asr` (TASK-1010 OD-8); the shared parser
  // drops an invalid value rather than forwarding it.
  const meta = isRec(row.metaData) ? row.metaData : {};
  const { profile: asr } = parseAiModelAsrProfile(meta.asr);

  // vLLM loads a DIRECTORY: `derivedLocalPath` never appends the primary object for a
  // multi-file library, and the trailing slash is dropped so the path is canonical.
  const localPath = derivedLocalPath(row)?.replace(/\/+$/, '') ?? null;

  const computeType = (SERVING_COMPUTE_TYPES as readonly string[]).includes(row.computeType ?? '') ? (row.computeType as ServingComputeType) : null;

  return {
    ok: true,
    spec: {
      slug: row.slug,
      kind,
      runtimeKey: `${row.id}:${row.checksum ?? `v${row.version}`}`,
      tenantId: row.tenantId,
      localPath,
      sourceUri: row.sourceUri,
      sourceRevision: row.sourceRevision ?? null,
      checksum: row.checksum ?? null,
      format: 'SAFETENSOR',
      computeType,
      quantization: asr.quantization ?? null,
      maxModelLen: asr.maxModelLen ?? null,
      engine,
    },
  };
}
