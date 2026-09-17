/**
 * TASK-965 OD-965-7 — the client-side comparison behind `VersionCompareDialog`.
 *
 * The owner decision is that 965 adds NO backend diff route: the versions routes already return
 * full bodies, so the only thing missing was the comparison. This module is therefore pure, has
 * no dependency, and is the one place the comparison's two judgement calls live.
 *
 * **Canonicalisation is half the value.** Two payloads that differ only in key order are the same
 * configuration; a diff that reported every line changed because `JSON.stringify` happened to
 * walk the keys differently would teach an admin to ignore it, which is worse than no diff. Array
 * order is left alone, because there it IS meaning (a fallback chain, a node list).
 *
 * **The size cap is honest, not silent.** A true LCS is O(n·m); beyond the cap the result is a
 * whole-document replacement and says `truncated: true` so the UI can tell the admin the diff is
 * coarse, rather than either freezing the tab or quietly showing something misleading.
 */

/** Above this many lines on either side, fall back to a whole-document replacement. */
const DEFAULT_MAX_LINES = 4000;

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number on the "from" side, or `null` for an added line. */
  fromLine: number | null;
  /** 1-based line number on the "to" side, or `null` for a removed line. */
  toLine: number | null;
}

export interface LineDiff {
  lines: DiffLine[];
  stats: { additions: number; deletions: number };
  identical: boolean;
  /** The pair exceeded the cap, so this is a whole-document replacement, not a real diff. */
  truncated: boolean;
}

/** Recursively order object keys so key order alone is never reported as a change. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalise(source[key]);
        return accumulator;
      }, {});
  }
  return value;
}

/**
 * The comparable text of a version payload: a string body (a prompt, a markdown template) passes
 * through untouched; anything else is pretty-printed JSON with a stable key order. A nullish
 * payload is an EMPTY document, never the text "undefined".
 */
export function toComparableJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(canonicalise(value), null, 2) ?? '';
  } catch {
    // Circular or non-serialisable: say so in the document rather than throwing inside a render.
    return String(value);
  }
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

function wholeDocumentReplacement(from: string[], to: string[]): LineDiff {
  const lines: DiffLine[] = [
    ...from.map((text, index) => ({ kind: 'removed' as const, text, fromLine: index + 1, toLine: null })),
    ...to.map((text, index) => ({ kind: 'added' as const, text, fromLine: null, toLine: index + 1 })),
  ];
  return { lines, stats: { additions: to.length, deletions: from.length }, identical: false, truncated: true };
}

/**
 * A line diff over the longest common subsequence. At each change site removals are emitted
 * before additions (the unified convention), so a reader sees the old line above the new one.
 */
export function diffLines(fromText: string, toText: string, options: { maxLines?: number } = {}): LineDiff {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const from = splitLines(fromText);
  const to = splitLines(toText);

  if (fromText === toText) {
    return {
      lines: from.map((text, index) => ({ kind: 'context' as const, text, fromLine: index + 1, toLine: index + 1 })),
      stats: { additions: 0, deletions: 0 },
      identical: true,
      truncated: false,
    };
  }

  if (from.length > maxLines || to.length > maxLines) return wholeDocumentReplacement(from, to);

  // LCS lengths table; `table[i][j]` is the LCS of from[i..] and to[j..].
  const table: number[][] = Array.from({ length: from.length + 1 }, () => new Array<number>(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i][j] = from[i] === to[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      lines.push({ kind: 'context', text: from[i], fromLine: i + 1, toLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'removed', text: from[i], fromLine: i + 1, toLine: null });
      deletions += 1;
      i += 1;
    } else {
      lines.push({ kind: 'added', text: to[j], fromLine: null, toLine: j + 1 });
      additions += 1;
      j += 1;
    }
  }
  while (i < from.length) {
    lines.push({ kind: 'removed', text: from[i], fromLine: i + 1, toLine: null });
    deletions += 1;
    i += 1;
  }
  while (j < to.length) {
    lines.push({ kind: 'added', text: to[j], fromLine: null, toLine: j + 1 });
    additions += 1;
    j += 1;
  }

  return { lines, stats: { additions, deletions }, identical: additions === 0 && deletions === 0, truncated: false };
}
