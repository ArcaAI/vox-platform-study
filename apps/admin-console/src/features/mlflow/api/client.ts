/**
 * MLflow read plane — through the gateway, never from the browser.
 *
 * The browser cannot talk to MLflow directly even where a URL exists: MLflow's
 * security middleware blocks cross-origin state-changing requests and its
 * Flask-CORS allow-list covers localhost patterns only, so a console-origin
 * fetch is refused. The gateway reaches the tracking server in-cluster and
 * applies the console's own authorization, which is also how MLflow's complete
 * absence of authentication of its own stops being the console's problem.
 */

import { getJson } from '@/shared/api';
import type { MlflowExperimentsResponse, MlflowModelVersionsResponse, MlflowRegisteredModelsResponse, MlflowStatus } from './types';

const BASE = 'admin/ai-services/mlflow';

/** Page size for every listing. MLflow caps it server-side; the gateway DTO caps it again at 1000. */
export const MLFLOW_PAGE_SIZE = 100;

/** Reachability, version and the OBSERVED framing posture. Never rejects on an unreachable server. */
export function getMlflowStatus(): Promise<MlflowStatus> {
  return getJson(`${BASE}/status`);
}

export function searchMlflowRegisteredModels(): Promise<MlflowRegisteredModelsResponse> {
  return getJson(`${BASE}/registered-models`, { maxResults: MLFLOW_PAGE_SIZE });
}

export function searchMlflowModelVersions(): Promise<MlflowModelVersionsResponse> {
  return getJson(`${BASE}/model-versions`, { maxResults: MLFLOW_PAGE_SIZE, orderBy: 'last_updated_timestamp DESC' });
}

export function searchMlflowExperiments(): Promise<MlflowExperimentsResponse> {
  return getJson(`${BASE}/experiments`, { maxResults: MLFLOW_PAGE_SIZE });
}
