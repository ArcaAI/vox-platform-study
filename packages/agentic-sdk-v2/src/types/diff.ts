/**
 * @arcaai/vox - Diff Types
 *
 * Types for text diffing and version comparison.
 * Used by diffUtils for comparing prompt versions and summary edits.
 */

// =============================================================================
// Diff Change
// =============================================================================

/**
 * A single change segment from a diff operation.
 * Compatible with the `diff` npm package output.
 */
export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
  count?: number;
}

// =============================================================================
// Diff Result
// =============================================================================

/**
 * Complete result from a diff operation.
 */
export interface DiffResult {
  changes: DiffChange[];
  patch: string;
  stats: DiffStats;
}

/**
 * Statistics from a diff operation.
 */
export interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

/**
 * Diff comparison mode.
 */
export type DiffMode = 'lines' | 'words' | 'chars';

// =============================================================================
// Prompt version diff (server superset)
// =============================================================================

/**
 * One field's diff within a prompt version comparison (e.g. `content` vs
 * `variables`). Part of the server superset returned by the prompt version-diff
 * endpoint that `usePrompts().compareVersions` collapses to the combined
 * `{ changes, patch, stats }`. Consume it via `compareVersionsDetailed`.
 */
export interface PromptVersionDiffField {
  /** The compared field, e.g. `content` or `variables`. */
  field: string;
  /** True when the two versions differ on this field. */
  changed: boolean;
  changes: DiffChange[];
  stats: DiffStats;
}

/**
 * The full server superset from the prompt version-diff endpoint. Extends the
 * back-compat {@link DiffResult} (combined content+variables line diff) with the
 * comparison metadata and the per-field breakdown.
 */
export interface PromptVersionDiff extends DiffResult {
  promptTemplateId: string;
  fromVersion: number;
  toVersion: number;
  fields: PromptVersionDiffField[];
}
