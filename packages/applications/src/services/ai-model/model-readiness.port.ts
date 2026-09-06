import type { ModelReadiness } from './dto/model-catalogue.response';

/**
 * The seam between the tenant catalogue (TASK-890 L1, wave 1) and the readiness
 * SNAPSHOT that fills it in (L12, wave 2b).
 *
 * Declared HERE, on the consumer side, on purpose: the catalogue must ship and
 * be correct before any probe exists, so it injects this token `@Optional()` and
 * stamps `unknown` when nothing provides it. L12's `InferenceReadinessService`
 * implements the port and provides the token from its own module; NOTHING else
 * about the catalogue changes when it lands.
 *
 * The contract is deliberately one method returning ONE stored snapshot: a
 * tenant reading the catalogue must never cause a vendor call or an engine
 * round trip (§3.12 — "tenants never trigger probes; they read the platform's
 * last observation").
 */
export const IInferenceReadinessService = Symbol('IInferenceReadinessService');

/** One row of the snapshot: what a model was last observed to be. */
export interface ModelReadinessObservation {
  readiness: ModelReadiness;
  /** Non-secret cause, e.g. `engine listed the model but it is not resident`. Never a backend error string. */
  detail?: string | null;
}

/** The stored snapshot the catalogue joins against, keyed by `AiModel.id`. */
export interface InferenceReadinessSnapshot {
  /** When the sweep that produced this snapshot ran — the "at that point of time" the console shows. */
  checkedAt: Date;
  models: Record<string, ModelReadinessObservation>;
}

export interface IInferenceReadinessServicePort {
  /**
   * The last completed sweep, or `null` when none has run (cold cache, cron
   * disabled). NEVER probes on demand — a null answer means `unknown`, not
   * "go and find out".
   */
  getSnapshot(): Promise<InferenceReadinessSnapshot | null>;
}
