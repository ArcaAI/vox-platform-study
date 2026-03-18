/**
 * @arcaai/vox - Diff Utilities
 *
 * Text diffing utilities for comparing prompt versions and summary edits.
 * Wraps the `diff` npm package with typed helpers.
 */

import { diffLines, diffWords, diffChars, createPatch } from 'diff';
import type { ChangeObject } from 'diff';
import type { DiffChange, DiffResult, DiffStats, DiffMode } from '../types/diff';

function runDiff(oldText: string, newText: string, mode: DiffMode): ChangeObject<string>[] {
  switch (mode) {
    case 'words': return diffWords(oldText, newText);
    case 'chars': return diffChars(oldText, newText);
    default: return diffLines(oldText, newText);
  }
}

/**
 * Compute a diff between two strings.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  mode: DiffMode = 'lines',
): DiffResult {
  const rawChanges = runDiff(oldText, newText, mode);
  const changes: DiffChange[] = rawChanges.map(c => ({
    value: c.value,
    added: c.added || undefined,
    removed: c.removed || undefined,
    count: c.count,
  }));
  const stats = computeStats(changes);
  const patch = createPatch('content', oldText, newText, '', '');
  return { changes, patch, stats };
}

/**
 * Compute a line-level diff for prompt templates.
 */
export function computePromptDiff(
  oldContent: string,
  newContent: string,
): DiffResult {
  return computeDiff(oldContent, newContent, 'lines');
}

/**
 * Compute a word-level diff for summaries (prose text).
 */
export function computeSummaryDiff(
  oldContent: string,
  newContent: string,
): DiffResult {
  return computeDiff(oldContent, newContent, 'words');
}

/**
 * Create a unified patch string for display.
 */
export function createUnifiedPatch(
  filename: string,
  oldStr: string,
  newStr: string,
): string {
  return createPatch(filename, oldStr, newStr, 'previous', 'current');
}

function computeStats(changes: DiffChange[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  let unchanged = 0;
  for (const change of changes) {
    const count = change.count ?? 1;
    if (change.added) additions += count;
    else if (change.removed) deletions += count;
    else unchanged += count;
  }
  return { additions, deletions, unchanged };
}
