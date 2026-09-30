/**
 * The engine-sizing DEFAULT a vLLM-served row gets at registration (TASK-1023 OD-9).
 *
 * `vramGiB` is required by the serving spec (`SERVING_FACTS_MISSING` otherwise), so a freshly
 * registered vLLM model used to be unservable until a platform admin PATCHed it. Registration now
 * writes an ESTIMATE — the weights plus a quarter for activations / KV cache plus one GiB of
 * runtime headroom — flagged `derived: true` so the console can present it as an estimate. It is
 * written only when absent: an admin's value is never overwritten.
 */

/** `AiModel.servedBy` of every row `apps/vllm` executes — the serving-spec route's own rule. */
const SERVED_BY_VLLM = 'vllm';
const GIB = 1024 ** 3;
const WEIGHTS_OVERHEAD = 1.25;
const RUNTIME_HEADROOM_GIB = 1;

/** Whether `apps/vllm` serves a row with this `servedBy` (and so needs `_metadata.serving.vramGiB`). */
export function isVllmServed(servedBy: string | null | undefined): boolean {
  return servedBy === SERVED_BY_VLLM;
}

/** `ceil(weightsGiB × 1.25 + 1)` — always ≥ 1. */
export function deriveVramGiB(weightBytes: number): number {
  const weightsGiB = Number.isFinite(weightBytes) && weightBytes > 0 ? weightBytes / GIB : 0;
  return Math.ceil(weightsGiB * WEIGHTS_OVERHEAD + RUNTIME_HEADROOM_GIB);
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `metaData` with `serving.vramGiB` defaulted for a vLLM-served row, or `metaData` itself
 * (same reference) when nothing is to be written: the row is not vLLM-served, or already carries
 * a `vramGiB`. Every other `_metadata` and `serving` key is kept.
 */
export function withDerivedServingFacts<T extends Rec | null | undefined>(
  metaData: T,
  input: { servedBy: string | null | undefined; weightBytes: number },
): T | Rec {
  if (!isVllmServed(input.servedBy)) return metaData;
  const serving = isRec(metaData) && isRec(metaData.serving) ? metaData.serving : {};
  if (serving.vramGiB !== undefined && serving.vramGiB !== null) return metaData;
  return { ...(metaData ?? {}), serving: { ...serving, vramGiB: deriveVramGiB(input.weightBytes), derived: true } };
}
