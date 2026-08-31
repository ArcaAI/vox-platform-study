/**
 * Wire types for the MLflow read plane.
 *
 * `MlflowStatus` mirrors the gateway DTO (`apps/api/src/modules/ai-service-admin/
 * mlflow-proxy.client.ts`). Everything below it is UPSTREAM-OWNED: MLflow's own
 * REST response shapes, proxied verbatim, in MLflow's own `snake_case`. They are
 * declared here as they appear on the wire — renaming them to camelCase would
 * put a translation layer between the operator and the registry they are looking
 * at, and every field would then be a thing that can silently go stale.
 *
 * Every upstream field is OPTIONAL on purpose. MLflow publishes no
 * breaking-change policy for these payloads, so a missing field must DEGRADE the
 * screen rather than crash it.
 */

export type MlflowProbeStatus = 'ok' | 'timeout' | 'error';

/** GET admin/ai-services/mlflow/status. Never fails: unreachable is a document. */
export interface MlflowStatus {
  /** What the GATEWAY calls. Never a browser address. */
  baseUrl: string;
  /** Browser-reachable MLflow UI, or null when none is configured (the default). */
  uiUrl: string | null;
  reachable: boolean;
  probeStatus: MlflowProbeStatus;
  latencyMs?: number;
  error?: string;
  version?: string;
  /** The `X-Frame-Options` value OBSERVED on the probe, or null when none was sent. */
  frameOptions: string | null;
  embeddable: boolean;
  embedBlockedReason: string | null;
}

/** MLflow `Experiment`. Timestamps are epoch milliseconds as STRINGS (proto int64). */
export interface MlflowExperiment {
  experiment_id?: string;
  name?: string;
  artifact_location?: string;
  lifecycle_stage?: string;
  creation_time?: string | number;
  last_update_time?: string | number;
  tags?: Array<{ key?: string; value?: string }>;
}

export interface MlflowRegisteredModel {
  name?: string;
  description?: string;
  user_id?: string;
  creation_timestamp?: string | number;
  last_updated_timestamp?: string | number;
  tags?: Array<{ key?: string; value?: string }>;
  aliases?: Array<{ alias?: string; version?: string }>;
  latest_versions?: MlflowModelVersion[];
}

export interface MlflowModelVersion {
  name?: string;
  version?: string;
  creation_timestamp?: string | number;
  last_updated_timestamp?: string | number;
  /** `READY` | `PENDING_REGISTRATION` | `FAILED_REGISTRATION`. */
  status?: string;
  status_message?: string;
  /** Where the weights actually live — the `hope-models` prefix, not an MLflow artifact URI. */
  source?: string;
  run_id?: string;
  description?: string;
  /** Aliases, not stages, are the promotion mechanism here. */
  aliases?: string[];
  tags?: Array<{ key?: string; value?: string }>;
}

export interface MlflowExperimentsResponse {
  experiments?: MlflowExperiment[];
  next_page_token?: string;
}

export interface MlflowRegisteredModelsResponse {
  registered_models?: MlflowRegisteredModel[];
  next_page_token?: string;
}

export interface MlflowModelVersionsResponse {
  model_versions?: MlflowModelVersion[];
  next_page_token?: string;
}
