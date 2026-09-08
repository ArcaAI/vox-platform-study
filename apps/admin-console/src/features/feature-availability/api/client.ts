/**
 * Feature-availability client. Paths are gateway-relative; the shared core
 * prepends the `/api/hope` BFF proxy mount.
 */

import { getJson, putJson } from '@/shared/api';
import type { EffectiveFeature, FeatureMatrix, FeatureMatrixWrite, FeatureMatrixWriteResult } from './types';

const BASE = 'admin/settings/features';

/**
 * The gates for the CALLER's context — an unscoped platform admin gets the
 * platform values, a scoped one the working tenant's, a tenant admin its own.
 */
export function getEffectiveFeatures(): Promise<{ items: EffectiveFeature[] }> {
  return getJson(`${BASE}/effective`);
}

/** The cross-tenant matrix. Super administrators only (403 otherwise). */
export function getFeatureMatrix(): Promise<FeatureMatrix> {
  return getJson(`${BASE}/matrix`);
}

/**
 * Apply a batch of cell edits under ONE approval.
 *
 * There is no `If-Match` header here and there could not be: each cell is a
 * separate row under a separate tenant with its own version, so the precondition
 * travels per cell as `expectedVersion`. The gateway answers 200 either way and
 * reports per-cell failures in `errors` — a drifted cell must not discard the
 * rest of a screenful of edits.
 */
export function putFeatureMatrix(cells: FeatureMatrixWrite[]): Promise<FeatureMatrixWriteResult> {
  return putJson(`${BASE}/matrix`, { cells });
}
