import type { AiModelServingKvCacheQuantizationType, AiModelServingProfile } from '@arcaai/types';

/**
 * TASK-996 Phase 3 — the VRAM arithmetic behind the load precheck (owner
 * decision D-6) and behind `kvCacheEstimateBytes` on the runtime read.
 *
 * EVERYTHING HERE IS AN ESTIMATE, and the ticket is emphatic about saying so
 * (§2.6): CUDA reports memory per PROCESS, DCGM reports it per DEVICE, and
 * nothing anywhere reports it per MODEL. The weights half is measured — it is
 * the GGUF's own `size_bytes`, which LM Studio reports — but the KV half is
 * DERIVED from `contextLength x parallel` and must never be rendered as a
 * measurement.
 *
 * WHY `context x parallel` AND NOT `context`. LM Studio gives EVERY decode slot
 * the FULL context window rather than dividing one window between them. That is
 * measured, not assumed: at 131072 x 10 the live pod held 13.9 GiB for prompts
 * of ~6k tokens, and halving the context while going 10 -> 4 slots took it to
 * 7.48 GiB — a 46% fall for a 10x fall in the product, which is what a linear
 * term with a fixed weights term looks like.
 *
 * WHY ONE CONSTANT AND NOT AN ARCHITECTURE MODEL. The exact KV footprint is
 * `2 x n_layers x n_kv_heads x head_dim x bytes_per_element` per token, and
 * NONE of those four numbers is reachable: LM Studio's HTTP API reports a
 * model's key, size, quantization and context window, and no layer geometry at
 * all (measured against `GET /api/v1/models` on the live pod). Inventing a
 * geometry table per model would be a fiction with more decimal places. So this
 * carries ONE calibrated rate, states where it came from, and is used only
 * where an over-estimate is the safe direction — a refusal to load.
 */

/**
 * Bytes of resident VRAM per KV slot at `f16`, calibrated against the live pod.
 *
 * Measured 2026-09-21 on `hope-lmstudio-7b69c877d8-7549p`, serving
 * `gemma-4-e2b-it-qat@q4_0` at contextLength 65536 x parallel 4 with flash
 * attention ON:
 *
 *   DCGM_FI_DEV_FB_USED, both cards  = 1,445 + 3,603 MiB = 5,293,015,040 B
 *   the GGUF's own `size_bytes`      =             3,349,516,256 B
 *   ------------------------------------------------------------------
 *   everything that is not weights   =             1,943,498,784 B
 *   / (65536 x 4) slots              =                     7,414 B/slot
 *
 * Rounded UP to 7.25 KiB. The residual also contains the CUDA context and the
 * engine's own graph buffers, so this OVER-states the KV term — which is the
 * direction a budget check should err in, and is stated here rather than
 * silently relied upon.
 *
 * It is calibrated on ONE model, so it is wrong for a model with a very
 * different layer geometry. Re-calibrate it the same way (used-minus-weights
 * over slots) if a second model's measured residency disagrees materially.
 */
export const KV_CACHE_BYTES_PER_TOKEN_F16 = 7424;

/**
 * Bytes per KV-cache element, by llama.cpp cache type.
 *
 * The quantized types carry their block overhead: `q8_0` is 8.5 bits/weight,
 * `q5_1` 6, `q5_0` 5.5, `q4_1` 5, and `q4_0`/`iq4_nl` 4.5 — so none of them is
 * the clean 1/2 or 1/4 of `f16` that a name suggests, and an estimate that
 * assumed it would under-state the budget on exactly the lever (R-3) this
 * ticket exists to expose.
 */
const KV_ELEMENT_BYTES: Readonly<Record<AiModelServingKvCacheQuantizationType, number>> = Object.freeze({
  f32: 4,
  f16: 2,
  q8_0: 8.5 / 8,
  q5_1: 6 / 8,
  q5_0: 5.5 / 8,
  q4_1: 5 / 8,
  q4_0: 4.5 / 8,
  iq4_nl: 4.5 / 8,
});

/**
 * How the chosen K and V element types scale the cache against the `f16`
 * baseline the constant above was calibrated at. K and V are half the cache
 * each, so the two halves scale independently.
 */
function quantizationScale(profile: AiModelServingProfile): number {
  const half = (type: AiModelServingKvCacheQuantizationType | undefined): number => (KV_ELEMENT_BYTES[type ?? 'f16'] ?? 2) / KV_ELEMENT_BYTES.f16;
  return (half(profile.kvCacheQuant?.k) + half(profile.kvCacheQuant?.v)) / 2;
}

/**
 * Estimated resident KV-cache bytes for a resolved serving profile.
 *
 * `0` when neither tier declared a window or a slot count: an unknown is
 * reported as an unknown, never as a guess dressed up as zero risk — the
 * callers that budget against it treat `0` as "nothing to add", and the only
 * profile that reaches them with no `contextLength` is one where no tier had an
 * opinion and the engine's own default applies.
 */
export function kvCacheEstimateBytes(profile: AiModelServingProfile): number {
  const contextLength = profile.contextLength;
  if (typeof contextLength !== 'number' || contextLength <= 0) return 0;
  const parallel = typeof profile.parallel === 'number' && profile.parallel > 0 ? profile.parallel : 1;
  return Math.round(contextLength * parallel * KV_CACHE_BYTES_PER_TOKEN_F16 * quantizationScale(profile));
}

/**
 * What loading this model on this profile is expected to cost: the measured
 * weights plus the derived KV cache.
 *
 * Compared by the precheck against the free VRAM of the BEST SINGLE CARD, never
 * against the sum of both — a model that does not fit one card is split across
 * them (`--split-mode layer`) and every decoded token then pays a PCIe hop,
 * which is the pathology this ticket exists to stop rather than to budget for.
 */
export function loadEstimateBytes(weightsBytes: number, profile: AiModelServingProfile): number {
  return Math.max(0, Math.round(weightsBytes)) + kvCacheEstimateBytes(profile);
}

/**
 * The `AiModel` column that carries the id the ENGINE answers to on the wire —
 * which is what an LM Studio model key is.
 *
 * Named here rather than inlined at the lookup because it is the one fact that
 * ties the catalogue row to the engine's `GET /api/v1/models[].key`, and it is
 * NOT `slug` (a HOPE-side name) or `sourceUri` (a locator).
 */
export const LM_STUDIO_MODEL_KEY = 'wireModelId' as const;
