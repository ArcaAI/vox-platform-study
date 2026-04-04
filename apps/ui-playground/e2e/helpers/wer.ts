/**
 * Word Error Rate (WER) computation utility.
 *
 * Reusable across all transcription E2E tests.
 * Uses Levenshtein distance at the word level (dynamic programming).
 */

export interface AlignedPair {
  type: 'match' | 'substitution' | 'deletion' | 'insertion';
  reference?: string;
  hypothesis?: string;
}

export interface WerResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
  hypothesisWords: number;
  alignedDiff: AlignedPair[];
}

export interface CerResult {
  cer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceChars: number;
  hypothesisChars: number;
}

/**
 * Normalize text for WER comparison.
 * Lowercase, strip punctuation, collapse whitespace, trim.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute Word Error Rate between a reference and hypothesis transcript.
 *
 * WER = (S + D + I) / N
 * where S = substitutions, D = deletions, I = insertions, N = reference word count.
 */
export function computeWer(reference: string, hypothesis: string): WerResult {
  const refWords = normalizeText(reference).split(/\s+/).filter(Boolean);
  const hypWords = normalizeText(hypothesis).split(/\s+/).filter(Boolean);

  const n = refWords.length;
  const m = hypWords.length;

  if (n === 0 && m === 0) {
    return {
      wer: 0,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      referenceWords: 0,
      hypothesisWords: 0,
      alignedDiff: [],
    };
  }

  if (n === 0) {
    return {
      wer: 1,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      referenceWords: 0,
      hypothesisWords: m,
      alignedDiff: hypWords.map((w) => ({ type: 'insertion', hypothesis: w })),
    };
  }

  // DP matrix: dp[i][j] = min edit distance between ref[0..i-1] and hyp[0..j-1]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + 1, // substitution
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
        );
      }
    }
  }

  // Backtrace to build alignment
  const alignedDiff: AlignedPair[] = [];
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && refWords[i - 1] === hypWords[j - 1]) {
      alignedDiff.unshift({ type: 'match', reference: refWords[i - 1], hypothesis: hypWords[j - 1] });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      alignedDiff.unshift({ type: 'substitution', reference: refWords[i - 1], hypothesis: hypWords[j - 1] });
      substitutions++;
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      alignedDiff.unshift({ type: 'deletion', reference: refWords[i - 1] });
      deletions++;
      i--;
    } else {
      alignedDiff.unshift({ type: 'insertion', hypothesis: hypWords[j - 1] });
      insertions++;
      j--;
    }
  }

  const wer = (substitutions + deletions + insertions) / n;

  return {
    wer,
    substitutions,
    deletions,
    insertions,
    referenceWords: n,
    hypothesisWords: m,
    alignedDiff,
  };
}

/**
 * Compute Character Error Rate between a reference and hypothesis transcript.
 *
 * CER = (S + D + I) / N at the character level.
 */
export function computeCer(reference: string, hypothesis: string): CerResult {
  const refChars = normalizeText(reference).replace(/\s+/g, '').split('');
  const hypChars = normalizeText(hypothesis).replace(/\s+/g, '').split('');

  const n = refChars.length;
  const m = hypChars.length;

  if (n === 0 && m === 0) {
    return { cer: 0, substitutions: 0, deletions: 0, insertions: 0, referenceChars: 0, hypothesisChars: 0 };
  }
  if (n === 0) {
    return { cer: 1, substitutions: 0, deletions: 0, insertions: m, referenceChars: 0, hypothesisChars: m };
  }

  // Use two-row DP to save memory (no backtrace needed for CER)
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let curr = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      if (refChars[i - 1] === hypChars[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(prev[j - 1] + 1, prev[j] + 1, curr[j - 1] + 1);
      }
    }
    [prev, curr] = [curr, prev];
  }

  const editDistance = prev[m];
  const subs = Math.min(n, m) > 0 ? editDistance - Math.abs(n - m) : 0;
  const dels = Math.max(0, n - m);
  const ins = Math.max(0, m - n);

  return {
    cer: Math.min(editDistance / n, 1),
    substitutions: Math.max(0, Math.round((subs + (editDistance - subs - Math.abs(n - m))) / 2)),
    deletions: dels,
    insertions: ins,
    referenceChars: n,
    hypothesisChars: m,
  };
}

/**
 * Format WER result for test output reporting.
 */
export function formatWerReport(result: WerResult, pipelineName: string, threshold: number, referenceText?: string, hypothesisText?: string): string {
  const status = result.wer <= threshold ? 'PASS' : 'FAIL';
  const matches = result.referenceWords - result.substitutions - result.deletions;
  const lines: string[] = [
    `${status}: Realtime transcription accuracy [${pipelineName}]`,
    `  WER: ${result.wer.toFixed(3)} (${(result.wer * 100).toFixed(1)}%) -- threshold: ${(threshold * 100).toFixed(0)}%`,
    `  Reference words: ${result.referenceWords}, Hypothesis words: ${result.hypothesisWords}`,
    `  Matches: ${matches}, Substitutions: ${result.substitutions}, Deletions: ${result.deletions}, Insertions: ${result.insertions}`,
  ];

  if (referenceText != null) {
    lines.push('');
    lines.push(`  Expected:`);
    lines.push(`    ${referenceText}`);
  }
  if (hypothesisText != null) {
    lines.push('');
    lines.push(`  Actual:`);
    lines.push(`    ${hypothesisText}`);
  }

  if (result.wer > threshold) {
    lines.push('');
    lines.push('  Discrepancies:');
    let wordIndex = 0;
    for (const pair of result.alignedDiff) {
      if (pair.type === 'match') {
        wordIndex++;
        continue;
      }
      if (pair.type === 'substitution') {
        wordIndex++;
        lines.push(`    [substitution] ref="${pair.reference}" hyp="${pair.hypothesis}" (word #${wordIndex})`);
      } else if (pair.type === 'deletion') {
        wordIndex++;
        lines.push(`    [deletion] ref="${pair.reference}" (word #${wordIndex})`);
      } else if (pair.type === 'insertion') {
        lines.push(`    [insertion] hyp="${pair.hypothesis}" (after word #${wordIndex})`);
      }
    }
  }

  return lines.join('\n');
}
