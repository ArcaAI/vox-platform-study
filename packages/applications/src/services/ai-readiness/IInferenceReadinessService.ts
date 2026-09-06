import type { InferenceReadinessSnapshot } from './inference-readiness.types';

export const IInferenceReadinessService = Symbol('IInferenceReadinessService');

/**
 * The platform's stored answer to "could this model have served, at the last
 * time anyone looked?" (TASK-890 §3.12).
 *
 * Two methods and no per-model read on purpose. A tenant reading the model
 * catalogue must never trigger a probe — it reads the platform's LAST
 * observation, once, and stamps every row from it (`modelReadinessFrom`).
 */
export interface IInferenceReadinessService {
  /**
   * The last stored observation, or `null` when there is none — cold process,
   * expired snapshot, or the sweep switched off. `null` is a first-class answer:
   * the caller reports `unknown`, never a guess.
   */
  getSnapshot(): Promise<InferenceReadinessSnapshot | null>;

  /**
   * Run ONE sweep now and store it, ignoring the interval. This is the
   * platform admin's "Probe now"; the scheduler uses its own gated entry point.
   */
  sweep(): Promise<InferenceReadinessSnapshot>;
}
