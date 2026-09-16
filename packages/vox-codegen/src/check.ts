/**
 * `--check` support, shared by both generator modes.
 *
 * Regenerates in memory and compares against whatever is committed on disk — the CI recipe: a
 * drifted generated file fails the build instead of silently going stale. The only expected
 * difference between two honest runs is the `Generated: <timestamp>` header line, so that line is
 * normalized out before comparing.
 */

import { readFile } from 'node:fs/promises';

/** Matches the header's `Generated: <ISO timestamp>` line so two runs a second apart still compare equal. */
const GENERATED_LINE_PATTERN = /^ \* Generated: .*$/m;

/** Replace the `Generated:` timestamp line with a fixed placeholder, so drift-checking ignores it. */
export function normalizeGeneratedTimestamp(contents: string): string {
  return contents.replace(GENERATED_LINE_PATTERN, ' * Generated: <normalized>');
}

/**
 * A minimal unified-style line diff: `-` for a line only in `expected`, `+` for a line only in
 * `actual`, ` ` for a line common to both — built off the standard LCS table. Good enough for a
 * CI failure message on a generated TypeScript file; not a general-purpose diff library.
 */
export function unifiedDiff(expected: string, actual: string): string {
  // `''.split('\n')` is `['']` — one phantom empty line, not zero lines. Treat the empty string
  // as genuinely empty so a missing on-disk file diffs as "every generated line is new", not as
  // one spurious removed blank line ahead of them.
  const a = expected === '' ? [] : expected.split('\n');
  const b = actual === '' ? [] : actual.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push(`- ${a[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    j += 1;
  }

  return lines.join('\n');
}

export interface CheckResult {
  /** `true` when the on-disk file matches what regenerating now would produce (timestamp aside). */
  matches: boolean;
  /** Present only when `matches` is `false` — a unified-style diff, `-` = on disk, `+` = freshly generated. */
  diff?: string;
}

/**
 * Compare freshly generated `contents` against whatever is on disk at `path`. A missing file is
 * drift (nothing to compare against, not a pass) — its diff shows every generated line as `+`
 * against an empty `expected`.
 */
export async function checkAgainstDisk(path: string, freshContents: string): Promise<CheckResult> {
  let onDisk: string;
  try {
    onDisk = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { matches: false, diff: unifiedDiff('', freshContents) };
    }
    throw error;
  }

  const normalizedOnDisk = normalizeGeneratedTimestamp(onDisk);
  const normalizedFresh = normalizeGeneratedTimestamp(freshContents);
  if (normalizedOnDisk === normalizedFresh) return { matches: true };
  return { matches: false, diff: unifiedDiff(normalizedOnDisk, normalizedFresh) };
}
