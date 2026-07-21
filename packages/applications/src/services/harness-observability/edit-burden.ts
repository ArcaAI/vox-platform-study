/**
 * Clinician edit-burden telemetry — surfaces a signal that already exists
 * in the gate but previously went unused.
 *
 * The clinician gate already emits its approve/edit decision and the delivered
 * (`RAW_SUMMARY`) vs signed (`MODIFIED_SUMMARY`) note versions into the WORM audit.
 * These are the derived, real-world quality proxies over that already-persisted
 * data — pure functions, no new capture, no workflow change:
 *
 *   - **edit distance** — word-level distance between delivered and signed note,
 *   - **deferral rate** — fraction of gate decisions that are not a clean pass,
 *   - **time-to-sign** — signed-off timestamp − delivered timestamp.
 *
 * PHI hygiene: the OUTPUT is only derived scalars (distance / rate / seconds) — the
 * note text is consumed to compute a distance and never returned or logged.
 */

/** A gate decision counts as "clean" (first-pass acceptance) when it is one of these. */
const CLEAN_DECISIONS = new Set(['PASS', 'APPROVE', 'APPROVED', 'SIGNED']);

/** Split text into word tokens (whitespace-delimited, empties dropped). */
function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Word-level Levenshtein distance between two note versions — the number of word
 * insertions/deletions/substitutions to turn `delivered` into `signed`. Word-level
 * (not character-level) because it approximates clinician edit effort.
 */
export function wordLevelEditDistance(delivered: string, signed: string): number {
  const a = tokenizeWords(delivered);
  const b = tokenizeWords(signed);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

export interface DeferralRate {
  total: number;
  deferrals: number;
  rate: number;
}

/**
 * Deferral rate over a gate-decision sequence: the fraction that are NOT a clean
 * pass (i.e. FLAG / REGEN / escalated / rejected). Higher = fewer first-pass
 * acceptances. An empty sequence yields rate 0 (the composer decides `null`).
 */
export function deferralRate(decisions: string[]): DeferralRate {
  const total = decisions.length;
  const deferrals = decisions.filter((d) => !CLEAN_DECISIONS.has(d.trim().toUpperCase())).length;
  return { total, deferrals, rate: total > 0 ? deferrals / total : 0 };
}

/**
 * Time-to-sign in whole seconds (signed − delivered). `null` when either timestamp
 * is missing; clamped to 0 for an anomalous signed-before-delivered pair.
 */
export function timeToSignSeconds(deliveredAt: Date | string | null | undefined, signedAt: Date | string | null | undefined): number | null {
  const delivered = toEpochMs(deliveredAt);
  const signed = toEpochMs(signedAt);
  if (delivered === null || signed === null) return null;
  return Math.max(0, Math.floor((signed - delivered) / 1000));
}

export interface EditBurdenInput {
  /** Delivered `RAW_SUMMARY` note text (decrypted, transient — never returned). */
  deliveredContent?: string | null;
  /** Signed `MODIFIED_SUMMARY` note text (decrypted, transient — never returned). */
  signedContent?: string | null;
  /** Gate-decision token sequence (e.g. `gateDecision` column values + escalations). */
  decisions?: string[];
  deliveredAt?: Date | string | null;
  signedAt?: Date | string | null;
}

/** Derived edit-burden scalars — the only thing that leaves this module. */
export interface EditBurden {
  /** Word-level edit distance delivered→signed; `null` when a version is missing. */
  editDistance: number | null;
  /** `editDistance` normalised by delivered word count; `null` when unavailable. */
  editDistanceRatio: number | null;
  /** Deferral rate over the gate decisions; `null` when there are none. */
  deferralRate: number | null;
  gateDecisionTotal: number;
  deferralCount: number;
  /** Signed − delivered, seconds; `null` when a timestamp is missing. */
  timeToSignSeconds: number | null;
  deliveredAt: string | null;
  signedAt: string | null;
}

/**
 * Compose the derived edit-burden scalars from already-persisted values. Every
 * signal degrades to `null` when its input is absent — no fabricated values, and
 * no note text ever appears in the result.
 */
export function computeEditBurden(input: EditBurdenInput): EditBurden {
  const { deliveredContent, signedContent, decisions = [] } = input;

  let editDistance: number | null = null;
  let editDistanceRatio: number | null = null;
  if (deliveredContent != null && signedContent != null) {
    editDistance = wordLevelEditDistance(deliveredContent, signedContent);
    const deliveredWords = tokenizeWords(deliveredContent).length;
    editDistanceRatio = editDistance / Math.max(deliveredWords, 1);
  }

  const deferral = deferralRate(decisions);

  return {
    editDistance,
    editDistanceRatio,
    deferralRate: deferral.total > 0 ? deferral.rate : null,
    gateDecisionTotal: deferral.total,
    deferralCount: deferral.deferrals,
    timeToSignSeconds: timeToSignSeconds(input.deliveredAt, input.signedAt),
    deliveredAt: toIso(input.deliveredAt),
    signedAt: toIso(input.signedAt),
  };
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(value: Date | string | null | undefined): string | null {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}
