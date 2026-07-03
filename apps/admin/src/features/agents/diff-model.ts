import type { DiffResult, PromptVersionDiff } from '@arcaai/vox';

/**
 * Adapts the SDK `DiffResult` (line-level `changes` from `usePrompts.compareVersions`)
 * into two aligned columns for the side-by-side **Version Diff** (frame 32). Removals
 * sit on the LEFT (base) with an empty placeholder on the right; additions sit on the
 * RIGHT (compare) with an empty placeholder on the left; unchanged lines are aligned
 * context on both sides. The component tones add/remove with semantic tokens
 * (`--success` / `--destructive`) — never raw green/red.
 */
export type DiffCellKind = 'context' | 'add' | 'remove' | 'empty';

export interface DiffCell {
  kind: DiffCellKind;
  /** 1-based line number within its side, or null for an alignment placeholder. */
  no: number | null;
  text: string;
}

export interface DiffColumns {
  left: DiffCell[];
  right: DiffCell[];
}

/** Split a diff chunk's value into lines, dropping the artifact trailing empty line. */
function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function toDiffColumns(diff: DiffResult): DiffColumns {
  const left: DiffCell[] = [];
  const right: DiffCell[] = [];
  let leftNo = 0;
  let rightNo = 0;

  for (const change of diff.changes) {
    const lines = splitLines(change.value);
    if (change.added) {
      for (const text of lines) {
        right.push({ kind: 'add', no: ++rightNo, text });
        left.push({ kind: 'empty', no: null, text: '' });
      }
    } else if (change.removed) {
      for (const text of lines) {
        left.push({ kind: 'remove', no: ++leftNo, text });
        right.push({ kind: 'empty', no: null, text: '' });
      }
    } else {
      for (const text of lines) {
        left.push({ kind: 'context', no: ++leftNo, text });
        right.push({ kind: 'context', no: ++rightNo, text });
      }
    }
  }

  return { left, right };
}

/** Additions/removals counts from the diff stats (for the diff header). */
export function summarizeDiff(diff: DiffResult): { additions: number; removals: number } {
  return { additions: diff.stats.additions, removals: diff.stats.deletions };
}

/**
 * TASK-394 P0-2 — per-field breakdown of a {@link PromptVersionDiff} (which field
 * changed and by how much), for the diff header chips. The server superset always
 * carries `fields`, but we degrade to `[]` when a legacy response omits it.
 */
export interface FieldDiffSummary {
  field: string;
  changed: boolean;
  additions: number;
  removals: number;
}

export function summarizeFields(diff: Pick<PromptVersionDiff, 'fields'>): FieldDiffSummary[] {
  return (diff.fields ?? []).map((f) => ({
    field: f.field,
    changed: f.changed,
    additions: f.stats.additions,
    removals: f.stats.deletions,
  }));
}
