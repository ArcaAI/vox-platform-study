/**
 * Wire types for the feature-availability plane (`admin/settings/features/*`).
 *
 * Re-declared here rather than imported: the console cannot import
 * `@arcaai/applications`, and a feature module may not import another feature's
 * api (rule 13 — features never import each other). The shapes mirror
 * `EffectiveFeaturesResponse` / `FeatureMatrixResponse` /
 * `FeatureMatrixWriteResponse` in `apps/api/src/modules/settings-catalog/dto`.
 */

/** The platform-default column id. NOT a tenant — the reserved SYSTEM tier. */
export const PLATFORM_COLUMN = 'system';

/** One resolved gate for the calling context. `GET features/effective`. */
export interface EffectiveFeature {
  key: string;
  value: boolean;
  /** Which tier answered: a tenant override, the platform row, or the code default. */
  sourceScope: 'system' | 'tenant' | 'default';
}

/** A feature ROW on the matrix. */
export interface FeatureMatrixFeature {
  key: string;
  label?: string;
  description?: string;
  /** What a tenant inherits when neither it nor the platform holds a row. */
  default: boolean;
  /**
   * `system` means the key has NO per-tenant row — its consumer has no tenant in
   * hand — so the screen disables its tenant cells rather than offering a
   * checkbox the cascade would ignore.
   */
  maxScope: 'system' | 'tenant' | 'department' | 'doctor';
  killSwitch?: boolean;
  category: string;
}

export interface FeatureMatrixTenant {
  id: string;
  name: string;
  slug: string;
}

export interface FeatureMatrixCell {
  key: string;
  /** A tenant id, or {@link PLATFORM_COLUMN}. */
  tenantId: string;
  /** `null` = no row: this tenant INHERITS. The platform column is never null. */
  value: boolean | null;
  /** Backing row version; 0 when nothing is stored. Echo as `expectedVersion`. */
  version: number;
}

export interface FeatureMatrix {
  features: FeatureMatrixFeature[];
  tenants: FeatureMatrixTenant[];
  cells: FeatureMatrixCell[];
}

export interface FeatureMatrixWrite {
  key: string;
  tenantId: string;
  /** `null` resets: a tenant cell drops its override, the platform cell returns to the descriptor default. */
  value: boolean | null;
  expectedVersion?: number;
}

export interface FeatureMatrixCellError {
  key: string;
  tenantId: string;
  /** The status this cell would have produced as a single-key request. */
  status: number;
  message: string;
}

/**
 * `PUT features/matrix`. The batch is ORDERED and PARTIAL and answers 200 either
 * way — `errors` is where a drifted or refused cell reports, so one stale cell
 * cannot discard a screenful of valid edits.
 */
export interface FeatureMatrixWriteResult {
  cells: FeatureMatrixCell[];
  errors: FeatureMatrixCellError[];
}
