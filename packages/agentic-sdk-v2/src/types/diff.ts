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
