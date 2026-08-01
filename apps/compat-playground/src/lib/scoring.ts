/**
 * WER / CER scoring for the compat playground (TASK-597 lane D, finding G2).
 *
 * ## Source of truth
 *
 * The normalization and the CER algorithm here are a **behavioural port of**
 * `apps/stt/scripts/mlen_scorecard.py` (`_norm` at :43-44, `cer` at :47-57) —
 * the reference implementation that produces the TASK-594 Malayalam-English
 * quality gate's numbers (`apps/stt/tests/integration/test_mlen_quality_gate.py`,
 * baseline `apps/stt/tests/integration/mlen_scorecard_baseline.json`).
 *
 * If this file and that script disagree, an engineer comparing a playground run
 * against the regression baseline will chase a phantom regression. **Do not
 * "improve" the behaviour below** — change it only in lockstep with the Python
 * script, and re-verify the cross-check fixtures in
 * `src/lib/__tests__/scoring.test.tsx`.
 *
 * The Python normalizer is exactly three steps and nothing else:
 *
 * ```python
 * def _norm(s: str) -> str:
 *     return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()
 * ```
 *
 * 1. Unicode **NFC** normalization.
 * 2. Every run of whitespace collapsed to a single U+0020.
 * 3. Leading/trailing whitespace stripped.
 *
 * Deliberately **NOT** done, and therefore not done here either:
 * case folding, punctuation stripping, digit/number normalization,
 * transliteration, or diacritic removal. `"The Patient"` vs `"the patient"`
 * scores as 2 substitutions, and a dropped full stop counts as one deletion.
 *
 * ## Two Unicode details that make the port exact
 *
 * - Python iterates a `str` by **code point**; JavaScript indexes by UTF-16
 *   code unit. Every character-level operation below goes through
 *   {@link toCharacters}, which splits on code points, so an astral character
 *   costs 1 edit here just as it does in Python. (Malayalam is entirely BMP, so
 *   this only matters for emoji/rare scripts — but "only matters sometimes" is
 *   how divergence starts.)
 * - Python's `\s` and JavaScript's `\s` are *not* the same set: Python adds
 *   U+001C–U+001F and U+0085, JavaScript adds U+FEFF. The class below is
 *   spelled out explicitly to match Python's, which is also exactly the set
 *   `str.strip()` removes.
 *
 * Everything in this module is a pure function — no React, no DOM.
 */

// ---------------------------------------------------------------------------
// Normalization — the ported `_norm`
// ---------------------------------------------------------------------------

/**
 * Python's Unicode `\s` (and, identically, the set `str.strip()` removes).
 * Spelled out rather than using JS `\s`; see the module header.
 */
const PYTHON_WHITESPACE = '\\t\\n\\v\\f\\r\\x1C-\\x1F \\x85\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';

const WHITESPACE_RUN = new RegExp(`[${PYTHON_WHITESPACE}]+`, 'gu');
const WHITESPACE_EDGES = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, 'gu');

/**
 * The ported `_norm`: NFC → collapse whitespace runs to one space → strip.
 *
 * Case and punctuation are preserved on purpose (see the module header).
 */
export function normalizeForScoring(text: string): string {
  return text.normalize('NFC').replace(WHITESPACE_RUN, ' ').replace(WHITESPACE_EDGES, '');
}

/** Split into Unicode code points, matching how Python iterates a `str`. */
export function toCharacters(text: string): string[] {
  return Array.from(text);
}

/**
 * Whitespace-delimited tokens of the normalized text.
 *
 * After {@link normalizeForScoring} every separator is a single U+0020, so a
 * plain split is enough; the empty-string guard keeps `''` from yielding `['']`.
 */
export function toWords(text: string): string[] {
  const normalized = normalizeForScoring(text);
  return normalized === '' ? [] : normalized.split(' ');
}

// ---------------------------------------------------------------------------
// CER — the ported `cer`
// ---------------------------------------------------------------------------

/**
 * Character error rate, NFC-normalized and whitespace-collapsed.
 *
 * Verbatim port of `mlen_scorecard.py::cer`, including its denominator
 * `max(1, len(ref))`. That guard means an **empty reference with a non-empty
 * hypothesis returns `len(hyp)`, not a ratio** — e.g. `cer('', 'hello') === 5`.
 * The Python gate has the same behaviour; callers that need a bounded display
 * value clamp at the UI layer, not here.
 *
 * Complexity: O(R·H) time, O(H) memory (single rolling row) — the same shape as
 * the Python loop. A pair of 5 000-character transcripts is ~25 M cell updates,
 * which runs in well under a second; nothing here is worth optimizing further
 * for a developer console.
 */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const r = toCharacters(normalizeForScoring(reference));
  const h = toCharacters(normalizeForScoring(hypothesis));

  const dp = new Array<number>(h.length + 1);
  for (let j = 0; j <= h.length; j += 1) dp[j] = j;

  for (let i = 1; i <= r.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const current = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (r[i - 1] === h[j - 1] ? 0 : 1));
      prev = current;
    }
  }

  return dp[h.length] / Math.max(1, r.length);
}

// ---------------------------------------------------------------------------
// WER + word-level alignment
// ---------------------------------------------------------------------------

/** One step of the reference↔hypothesis word alignment. */
export interface AlignmentOp {
  kind: 'equal' | 'substitution' | 'insertion' | 'deletion';
  /** The reference word — absent for an insertion. */
  reference?: string;
  /** The hypothesis word — absent for a deletion. */
  hypothesis?: string;
}

export interface WordScore {
  /** `(S + I + D) / max(1, referenceWords)` — same denominator guard as CER. */
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  /** Words that matched exactly (case- and punctuation-sensitive). */
  hits: number;
  referenceWords: number;
  hypothesisWords: number;
  /** Left-to-right alignment, suitable for rendering a diff. */
  alignment: AlignmentOp[];
}

// Backpointer codes packed into a Uint8Array — 1 byte per DP cell instead of a
// full number[][] matrix.
const OP_DIAGONAL = 0; // match or substitution
const OP_DELETE = 1; // reference word consumed, nothing in the hypothesis
const OP_INSERT = 2; // hypothesis word consumed, nothing in the reference

/**
 * Token-level WER with substitution / insertion / deletion counts and the
 * alignment that produced them.
 *
 * Tokens come from {@link toWords}, i.e. the SAME normalization the CER uses —
 * so a WER and a CER printed side by side always describe the same two strings.
 *
 * Complexity: O(R·H) time and O(R·H) bytes for the backpointer table (plus one
 * rolling cost row). At 2 000 words a side that is ~4 MB and a few milliseconds;
 * realistic consultation transcripts are far smaller. A standard DP matrix is
 * the right call here — anything cleverer (Hirschberg, banded DP) would be
 * unjustified complexity for a developer console.
 */
export function wordErrorRate(reference: string, hypothesis: string): WordScore {
  const ref = toWords(reference);
  const hyp = toWords(hypothesis);
  const width = hyp.length + 1;

  // Only the interior is written; the backtrace handles the i===0 / j===0 edges
  // directly (an exhausted reference can only be insertions, and vice versa).
  const backpointers = new Uint8Array((ref.length + 1) * width);

  const cost = new Array<number>(width);
  for (let j = 0; j < width; j += 1) cost[j] = j;

  for (let i = 1; i <= ref.length; i += 1) {
    let diagonal = cost[0];
    cost[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const above = cost[j]; // dp[i-1][j] — deletion
      const left = cost[j - 1]; // dp[i][j-1] — insertion
      const substitutionCost = diagonal + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const deletionCost = above + 1;
      const insertionCost = left + 1;

      // Tie-break diagonal → deletion → insertion, so an equal pair is always
      // preferred and the alignment stays stable.
      let best = substitutionCost;
      let op = OP_DIAGONAL;
      if (deletionCost < best) {
        best = deletionCost;
        op = OP_DELETE;
      }
      if (insertionCost < best) {
        best = insertionCost;
        op = OP_INSERT;
      }

      diagonal = above;
      cost[j] = best;
      backpointers[i * width + j] = op;
    }
  }

  const alignment: AlignmentOp[] = [];
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let hits = 0;

  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    const op = i === 0 ? OP_INSERT : j === 0 ? OP_DELETE : backpointers[i * width + j];
    if (op === OP_DIAGONAL) {
      const refWord = ref[i - 1];
      const hypWord = hyp[j - 1];
      if (refWord === hypWord) {
        hits += 1;
        alignment.push({ kind: 'equal', reference: refWord, hypothesis: hypWord });
      } else {
        substitutions += 1;
        alignment.push({ kind: 'substitution', reference: refWord, hypothesis: hypWord });
      }
      i -= 1;
      j -= 1;
    } else if (op === OP_DELETE) {
      deletions += 1;
      alignment.push({ kind: 'deletion', reference: ref[i - 1] });
      i -= 1;
    } else {
      insertions += 1;
      alignment.push({ kind: 'insertion', hypothesis: hyp[j - 1] });
      j -= 1;
    }
  }
  alignment.reverse();

  return {
    wer: (substitutions + insertions + deletions) / Math.max(1, ref.length),
    substitutions,
    insertions,
    deletions,
    hits,
    referenceWords: ref.length,
    hypothesisWords: hyp.length,
    alignment,
  };
}

// ---------------------------------------------------------------------------
// Combined scorecard
// ---------------------------------------------------------------------------

export interface Scorecard extends WordScore {
  /** From {@link characterErrorRate} — the number the TASK-594 gate reports. */
  cer: number;
  referenceCharacters: number;
  hypothesisCharacters: number;
  /** The normalized strings both metrics were computed over. */
  normalizedReference: string;
  normalizedHypothesis: string;
}

/** Score a hypothesis against a reference: CER, WER, S/I/D, and the alignment. */
export function scoreTranscript(reference: string, hypothesis: string): Scorecard {
  const normalizedReference = normalizeForScoring(reference);
  const normalizedHypothesis = normalizeForScoring(hypothesis);
  return {
    ...wordErrorRate(reference, hypothesis),
    cer: characterErrorRate(reference, hypothesis),
    referenceCharacters: toCharacters(normalizedReference).length,
    hypothesisCharacters: toCharacters(normalizedHypothesis).length,
    normalizedReference,
    normalizedHypothesis,
  };
}

// ---------------------------------------------------------------------------
// Reference-transcript parsing (.txt / .srt / .vtt)
// ---------------------------------------------------------------------------

/** Extensions accepted by the reference-transcript file input. */
export const REFERENCE_FILE_ACCEPT = '.txt,.srt,.vtt,text/plain';

const CUE_TIMECODE_LINE = /-->/;
const CUE_BLOCK_KEYWORD = /^(NOTE|STYLE|REGION)\b/;
/** VTT inline markup: `<v Doctor>`, `<c.loud>`, `<00:00:03.000>`, `</v>`. */
const CUE_INLINE_TAG = /<[^>]*>/g;

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Strip SubRip / WebVTT scaffolding down to the spoken text.
 *
 * Removes the `WEBVTT` header, `NOTE`/`STYLE`/`REGION` blocks, cue identifiers
 * (the SRT index or VTT cue id), timecode lines (including trailing cue settings
 * such as `align:start`), and inline cue tags; then joins the remaining cue text
 * with single spaces.
 *
 * A cue identifier is recognized STRUCTURALLY \u2014 the first line of a block whose
 * next line is a timecode \u2014 not by "looks like a number". A cue whose spoken
 * text is literally `500` is transcript content and must survive.
 */
export function parseCueFile(raw: string): string {
  const lines = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const spoken: string[] = [];
  let skippingBlock = false;
  let atBlockStart = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') {
      skippingBlock = false;
      atBlockStart = true;
      continue;
    }
    if (skippingBlock) continue;
    if (CUE_BLOCK_KEYWORD.test(line)) {
      skippingBlock = true;
      continue;
    }

    const wasBlockStart = atBlockStart;
    atBlockStart = false;

    if (line.startsWith('WEBVTT')) continue;
    if (CUE_TIMECODE_LINE.test(line)) continue;
    if (wasBlockStart && CUE_TIMECODE_LINE.test(lines[index + 1]?.trim() ?? '')) continue;

    const text = decodeBasicEntities(line.replace(CUE_INLINE_TAG, '')).trim();
    if (text !== '') spoken.push(text);
  }

  return spoken.join(' ');
}

/**
 * Turn an uploaded reference file into plain text.
 *
 * The format is chosen by extension when the filename is known, and otherwise
 * sniffed: any content carrying a `-->` timecode is treated as a cue file, so a
 * mis-named `.txt` export still parses. `.txt` is returned untouched —
 * {@link normalizeForScoring} does the whitespace work at scoring time.
 */
export function parseReferenceText(raw: string, filename?: string): string {
  const extension = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const isCueFile = extension === 'srt' || extension === 'vtt' || (extension === undefined && CUE_TIMECODE_LINE.test(raw));
  return isCueFile ? parseCueFile(raw) : raw.replace(/^\uFEFF/, '');
}

// ---------------------------------------------------------------------------
// Run export
// ---------------------------------------------------------------------------

/** Everything needed to tell two runs apart when comparing their scores. */
export interface ScorecardRunContext {
  /** The pipeline the run streamed through, or `null` for the tenant default. */
  pipelineId: string | null;
  /** STT language mode (TASK-587), e.g. `ml-en`. */
  languageMode: string;
  /** v2 consultation id, when one exists. */
  sessionId: string | null;
  /** Human description of the audio source (mic, file, mixed mics). */
  audioSource: string | null;
  /** Where the reference came from — `'pasted'` or a filename. */
  referenceSource: string;
}

export interface ScorecardRunExport {
  schema: 'arcaai.compat-playground.scorecard/v1';
  generatedAt: string;
  /**
   * Names the algorithm's source of truth so a stale export can never be
   * mistaken for a current one.
   */
  scoringReference: string;
  run: ScorecardRunContext;
  reference: string;
  hypothesis: string;
  scores: {
    cer: number;
    wer: number;
    substitutions: number;
    insertions: number;
    deletions: number;
    hits: number;
    referenceWords: number;
    hypothesisWords: number;
    referenceCharacters: number;
    hypothesisCharacters: number;
  };
  normalized: { reference: string; hypothesis: string };
  alignment: AlignmentOp[];
}

/** Build the JSON payload for "Export run" — comparable across pipeline switches. */
export function buildRunExport(reference: string, hypothesis: string, run: ScorecardRunContext, generatedAt: Date = new Date()): ScorecardRunExport {
  const score = scoreTranscript(reference, hypothesis);
  return {
    schema: 'arcaai.compat-playground.scorecard/v1',
    generatedAt: generatedAt.toISOString(),
    scoringReference: 'apps/stt/scripts/mlen_scorecard.py (_norm + cer) — TASK-594 quality-gate reference',
    run,
    reference,
    hypothesis,
    scores: {
      cer: score.cer,
      wer: score.wer,
      substitutions: score.substitutions,
      insertions: score.insertions,
      deletions: score.deletions,
      hits: score.hits,
      referenceWords: score.referenceWords,
      hypothesisWords: score.hypothesisWords,
      referenceCharacters: score.referenceCharacters,
      hypothesisCharacters: score.hypothesisCharacters,
    },
    normalized: { reference: score.normalizedReference, hypothesis: score.normalizedHypothesis },
    alignment: score.alignment,
  };
}

/** Percentage string for display, e.g. `0.1372 → "13.7%"`. Clamped display only. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
