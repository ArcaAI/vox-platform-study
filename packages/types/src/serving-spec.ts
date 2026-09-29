/**
 * TASK-1021 (C-1) — `ResolvedServingSpec`: everything `apps/vllm` needs to BUILD an engine for
 * one `AiModel` row, resolved by the gateway at
 * `GET /api/v1/internal/models/:slug/serving-spec` (tenant row first, then SYSTEM).
 *
 * ONE producer — `buildResolvedServingSpec()` in `@arcaai/applications`
 * (`services/ai-model/serving-spec`). The pydantic mirror lives in `apps/vllm`; both sides
 * validate the SAME committed fixture (`tests/contracts/resolved-serving-spec.fixture.json`),
 * which is the cross-language lock.
 *
 * Model identity is the ROW (D-13): `runtimeKey = "<aiModel.id>:<checksum ?? v<version>>"`, so
 * two tenants holding the same slug resolve two engines. Engine sizing facts come from
 * `AiModel._metadata.serving` (D-11); a row that declares no `vramGiB` is refused upstream and
 * never reaches this shape. Credentials never travel here.
 */

import { AI_MODEL_ASR_PROFILE_QUANTIZATIONS, type AiModelAsrProfileQuantization } from './asr-model-profile.js';

/**
 * What a served model does — derived from `AiModel.taskType` (the MODEL task, not the agent task):
 * `AUTOMATIC_SPEECH_RECOGNITION` → `asr`, `TEXT_GENERATION` → `llm`, `TEXT_TO_SPEECH` → `tts`.
 */
export const SERVING_KINDS = ['asr', 'llm', 'tts'] as const;
export type ServingKind = (typeof SERVING_KINDS)[number];

/** The weights precisions a vLLM engine accepts as `dtype`. `null` = the engine default. */
export const SERVING_COMPUTE_TYPES = ['float16', 'bfloat16', 'float32'] as const;
export type ServingComputeType = (typeof SERVING_COMPUTE_TYPES)[number];

/**
 * D-11 — the engine-sizing facts a vLLM-served row DECLARES on `AiModel._metadata.serving`, beside
 * (never inside) the LM Studio load profile that shares the key. `vramGiB` is required for the row
 * to be servable; the serving-spec builder refuses a row without it (`SERVING_FACTS_MISSING`).
 */
export type AiModelEngineServingFacts = {
  vramGiB?: number;
  maxNumSeqs?: number;
  enforceEager?: boolean;
};

/** Engine sizing, from `AiModel._metadata.serving`. `null` = the engine default applies. */
export interface ResolvedServingEngine {
  /** GPU memory the engine is sized to, in GiB (never a fraction of the card). Always > 0. */
  vramGiB: number;
  maxNumSeqs: number | null;
  enforceEager: boolean | null;
}

export interface ResolvedServingSpec {
  slug: string;
  kind: ServingKind;
  /** `${aiModel.id}:${checksum ?? `v${version}`}` — the engine-cache key. */
  runtimeKey: string;
  /** OWNER of the row (SYSTEM or the tenant) — never the caller's tenant by assumption. */
  tenantId: string;
  /** `deriveLocalPath(bucketPrefix, primaryObject)`; `null` when the row has no bucket prefix. */
  localPath: string | null;
  sourceUri: string;
  sourceRevision: string | null;
  checksum: string | null;
  format: 'SAFETENSOR';
  computeType: ServingComputeType | null;
  quantization: AiModelAsrProfileQuantization | null;
  maxModelLen: number | null;
  engine: ResolvedServingEngine;
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isPositiveInt = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const oneOfOrNull = (value: unknown, allowed: readonly unknown[]): boolean => value === null || allowed.includes(value);

const SPEC_KEYS = [
  'slug',
  'kind',
  'runtimeKey',
  'tenantId',
  'localPath',
  'sourceUri',
  'sourceRevision',
  'checksum',
  'format',
  'computeType',
  'quantization',
  'maxModelLen',
  'engine',
] as const;
const ENGINE_KEYS = ['vramGiB', 'maxNumSeqs', 'enforceEager'] as const;

/** Exactly these keys — a missing one or an extra one (a leaked credential) fails the guard. */
function hasExactKeys(value: Rec, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isResolvedServingEngine(value: unknown): value is ResolvedServingEngine {
  if (!isRec(value) || !hasExactKeys(value, ENGINE_KEYS)) return false;
  return (
    typeof value.vramGiB === 'number' &&
    Number.isFinite(value.vramGiB) &&
    value.vramGiB > 0 &&
    (value.maxNumSeqs === null || isPositiveInt(value.maxNumSeqs)) &&
    (value.enforceEager === null || typeof value.enforceEager === 'boolean')
  );
}

/** Structural guard: every key present, no extra key, and every value of its declared type. */
export function isResolvedServingSpec(value: unknown): value is ResolvedServingSpec {
  if (!isRec(value) || !hasExactKeys(value, SPEC_KEYS)) return false;
  return (
    typeof value.slug === 'string' &&
    value.slug.length > 0 &&
    (SERVING_KINDS as readonly unknown[]).includes(value.kind) &&
    typeof value.runtimeKey === 'string' &&
    value.runtimeKey.length > 0 &&
    typeof value.tenantId === 'string' &&
    value.tenantId.length > 0 &&
    isNullableString(value.localPath) &&
    typeof value.sourceUri === 'string' &&
    isNullableString(value.sourceRevision) &&
    isNullableString(value.checksum) &&
    value.format === 'SAFETENSOR' &&
    oneOfOrNull(value.computeType, SERVING_COMPUTE_TYPES) &&
    oneOfOrNull(value.quantization, AI_MODEL_ASR_PROFILE_QUANTIZATIONS) &&
    (value.maxModelLen === null || isPositiveInt(value.maxModelLen)) &&
    isResolvedServingEngine(value.engine)
  );
}
