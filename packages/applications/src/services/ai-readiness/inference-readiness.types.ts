/**
 * The readiness vocabulary (TASK-890 §3.7 / §3.12).
 *
 * ⚠ CANONICAL HOME. `ModelReadiness` and `ReadinessProviderClass` are declared
 * ONCE, here, and re-exported through the package barrel. The model-catalogue
 * DTO stamps the same values onto every row, so it IMPORTS these names rather
 * than restating them — two unions with the same members and different owners
 * drift the first time a state is added.
 */

/**
 * What the last observation says about one model row.
 *
 *   `ready`               — it could serve now (engine up and the weights
 *                           resident, or the platform service healthy with the
 *                           artifact in the bucket, or a keyed cloud connection).
 *   `loadable`            — the engine is up and knows the model, but it is not
 *                           resident; the first call pays a load.
 *   `engine_down`         — the thing that would serve it did not answer.
 *   `weights_missing`     — the serving side does not have the artifact: the
 *                           engine does not list it, or the bucket inventory
 *                           measured MISSING / PARTIAL.
 *   `credential_missing`  — a cloud row whose credential no tier supplies.
 *   `unknown`             — NOT a synonym for "bad". Nothing was measured: the
 *                           snapshot is cold, the sweep is off, the probe
 *                           aggregator was unreachable, or the inventory has
 *                           never run. It is reported as its own state so the
 *                           console can say "not measured" instead of implying
 *                           a verdict nobody produced.
 */
export type ModelReadiness = 'ready' | 'loadable' | 'engine_down' | 'weights_missing' | 'credential_missing' | 'unknown';

/** Every readiness state, for exhaustive UI maps and validation. */
export const MODEL_READINESS_STATES: readonly ModelReadiness[] = [
  'ready',
  'loadable',
  'engine_down',
  'weights_missing',
  'credential_missing',
  'unknown',
] as const;

/**
 * HOW a model is served, which is what decides how its readiness is derived.
 *
 *   `cloud-byo`          — a tenant row behind the tenant's own connection.
 *   `cloud-platform`     — a SYSTEM cloud row served on the platform credential.
 *   `engine-served`      — a SYSTEM row served by an engine the platform runs.
 *   `platform-self-host` — a SYSTEM row one of HOPE's own services serves out of
 *                          the models bucket (`provider: 'built-in'` and the
 *                          named TTS engines).
 */
export type ReadinessProviderClass = 'cloud-byo' | 'cloud-platform' | 'engine-served' | 'platform-self-host';

/** One engine, as the last sweep saw it. */
export interface ReadinessEngineEntry {
  /** Canonical provider spelling (`lmstudio` folded to `lm-studio`). */
  provider: string;
  providerClass: ReadinessProviderClass;
  /**
   * HOST ONLY — never the full URL, never a query string. An endpoint is
   * operational information a platform admin needs; a credential-bearing URL is
   * not, and this plane is read by a browser.
   */
  baseUrlHost: string | null;
  /** `unknown` means the aggregator itself did not answer — distinct from `down`. */
  status: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
  /** Models the engine reports as resident. */
  loadedCount: number;
  /** Models the engine lists at all. */
  listedCount: number;
  detail: string | null;
}

/** One HOPE service's heartbeat, as the last sweep read it. */
export interface ReadinessServiceEntry {
  key: string;
  healthy: boolean;
  lastSeenAt: string | null;
}

/** One model row's verdict. */
export interface ReadinessModelEntry {
  id: string;
  slug: string;
  taskType: string;
  provider: string | null;
  providerClass: ReadinessProviderClass | null;
  readiness: ModelReadiness;
  detail: string | null;
}

/**
 * ONE observation. `checkedAt` belongs to the sweep, not to a row — "at that
 * point of time" (OD-L) is the whole contract of this document.
 */
export interface InferenceReadinessSnapshot {
  checkedAt: string;
  engines: ReadinessEngineEntry[];
  services: ReadinessServiceEntry[];
  /** Keyed by `AiModel.id` so a catalogue read is one lookup per row. */
  models: Record<string, ReadinessModelEntry>;
}

/** One model's verdict plus the time it was observed. */
export interface ModelReadinessVerdict {
  readiness: ModelReadiness;
  detail: string | null;
  checkedAt: Date | null;
}

/**
 * Project one model out of a snapshot.
 *
 * A pure function rather than a service method so the catalogue can read the
 * snapshot ONCE per request and stamp N rows from it, and so an absent
 * snapshot has exactly one answer in exactly one place: `unknown`, with no
 * `checkedAt` — never a stale time attached to a fresh-looking verdict.
 */
export function modelReadinessFrom(snapshot: InferenceReadinessSnapshot | null, modelId: string): ModelReadinessVerdict {
  const entry = snapshot?.models[modelId];
  if (!snapshot || !entry) return { readiness: 'unknown', detail: null, checkedAt: null };
  return { readiness: entry.readiness, detail: entry.detail, checkedAt: new Date(snapshot.checkedAt) };
}
