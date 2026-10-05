import { FACT_KINDS, type FactKind } from './fact-ledger.schema';

/**
 * Deterministic repair of the extractor's drift, applied when a ledger is PERSISTED (and, for the
 * kind alone, when a stored ledger is rendered).
 *
 * A small model writes the key's prefix and the `kind` independently, and they disagree: measured
 * on live ledgers, `medication:metformin` came back as kind `history`, `vital:blood_pressure` as
 * `history`, `order:ecg` as `plan`. The kind decides criticality, coverage and the recap section,
 * so a drifted kind dropped a medication from the coverage set and filed it under "Reason". The key
 * itself drifted too (`allergy` with no term, `order:troponin blood test` with spaces), and the
 * model left `numbers` empty for doses and readings it stated in words.
 *
 * Nothing is invented: the term and the numbers are read off the fact's own statement.
 */

/** Key-prefix spellings → the fact kind they name. Only unambiguous synonyms. */
const PREFIX_KINDS: Readonly<Record<string, FactKind>> = {
  complaint: 'complaint',
  presenting_complaint: 'complaint',
  chief_complaint: 'complaint',
  symptom: 'complaint',
  symptoms: 'complaint',
  history: 'history',
  medication: 'medication',
  medications: 'medication',
  med: 'medication',
  meds: 'medication',
  drug: 'medication',
  dose_change: 'dose_change',
  allergy: 'allergy',
  allergies: 'allergy',
  vital: 'vital',
  vitals: 'vital',
  exam: 'exam',
  examination: 'exam',
  result: 'result',
  results: 'result',
  lab: 'result',
  labs: 'result',
  diagnosis: 'diagnosis',
  impression: 'diagnosis',
  plan: 'plan',
  order: 'order',
  orders: 'order',
  follow_up: 'follow_up',
  followup: 'follow_up',
  review: 'follow_up',
  red_flag: 'red_flag',
  negation: 'negation',
};

/**
 * The fact's kind, reconciled with its key prefix. A prefix naming a kind wins over a different
 * `kind`, except where the kind is the more specific statement about the same fact: a
 * `medication:` key whose kind is `dose_change`, and any `negation`.
 */
export function normaliseFactKind(key: string, kind: FactKind): FactKind {
  const prefix = snake(key.includes(':') ? key.slice(0, key.indexOf(':')) : key);
  const named = PREFIX_KINDS[prefix];
  if (!named || named === kind) return kind;
  if (kind === 'negation') return kind;
  if (kind === 'dose_change' && named === 'medication') return kind;
  return named;
}

/**
 * `prefix:term`, both lower snake case. A key with no term — or whose term only repeats its prefix
 * (`allergy`, `complaint:complaint`) — takes the term from the statement: the first content words
 * of its first clause ("Patient is allergic to penicillin, which…" → `penicillin`).
 */
export function normaliseFactKey(key: string, kind: FactKind, statement: string): string {
  const colon = key.indexOf(':');
  const rawPrefix = snake(colon >= 0 ? key.slice(0, colon) : key);
  const rawTerm = colon >= 0 ? snake(key.slice(colon + 1)) : '';
  // A bare key that names a kind is a prefix with no term; any other bare key is the term.
  const bareIsPrefix = colon < 0 && rawPrefix in PREFIX_KINDS;
  const prefix = colon >= 0 || bareIsPrefix ? rawPrefix || kind : kind;
  let term = colon >= 0 ? rawTerm : bareIsPrefix ? '' : rawPrefix;
  if (!term || (term in PREFIX_KINDS && PREFIX_KINDS[term] === PREFIX_KINDS[prefix])) term = termFromStatement(statement);
  return term ? `${prefix}:${term}` : prefix;
}

/** Kinds whose numbers carry the fact (a dose, a reading, an interval) and which units count. */
const NUMBER_KINDS: Readonly<Partial<Record<FactKind, 'with_unit' | 'any'>>> = {
  medication: 'with_unit',
  dose_change: 'with_unit',
  vital: 'any',
  result: 'any',
  follow_up: 'any',
};

/**
 * The values a dose / vital / result / follow-up statement states, when the model left `numbers`
 * empty. Number words become digits ("one thousand milligrams" → `1000 mg`); a reading keeps its
 * pair (`150/95`). A medication's bare numbers are not taken — only a value with a unit is a dose.
 */
export function numbersFromStatement(kind: FactKind, statement: string): Array<{ value: string; unit?: string }> {
  const mode = NUMBER_KINDS[kind];
  if (!mode) return [];
  const text = wordsToDigits(statement.toLowerCase());
  const out: Array<{ value: string; unit?: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(VALUE_WITH_UNIT)) {
    const value = match[1];
    const unit = match[2] ? canonicalUnit(match[2]) : undefined;
    if (!unit && mode === 'with_unit') continue;
    const id = `${value}|${unit ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(unit ? { value, unit } : { value });
  }
  return out;
}

/** True when `kind` is one of the declared fact kinds. */
export function isFactKind(kind: string): kind is FactKind {
  return (FACT_KINDS as readonly string[]).includes(kind);
}

// ------------------------------------------------------------------------------------------------

function snake(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Words that never name a fact's subject: function words, the speaker, the kind words. */
const NON_TERM_WORDS = new Set([
  ...['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'had', 'have'],
  ...['to', 'of', 'for', 'with', 'and', 'or', 'in', 'on', 'at', 'by', 'from', 'as', 'about', 'into'],
  ...['his', 'her', 'their', 'my', 'your', 'he', 'she', 'they', 'it', 'i', 'we', 'you', 'this', 'that'],
  ...['patient', 'pt', 'doctor', 'today', 'now', 'currently', 'also', 'very', 'some', 'any', 'still'],
  ...['reports', 'reported', 'says', 'said', 'states', 'stated', 'takes', 'taking', 'on', 'uses'],
  ...['allergic', 'allergy', 'allergies', 'complains', 'complaint', 'history', 'known', 'reaction'],
  ...['sending', 'send', 'sent', 'ordered', 'ordering', 'order', 'starting', 'start', 'started'],
]);

const DURATION_OR_NUMBER =
  /^(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|hundred|thousand|days?|weeks?|months?|years?|hours?)$/;

function termFromStatement(statement: string): string {
  const clause = statement.toLowerCase().split(/[,;:.(]|\bwhich\b|\bwho\b|\bbecause\b/)[0] ?? '';
  const words = clause.match(/[a-z][a-z0-9'-]*|\d+(?:\.\d+)?/g) ?? [];
  const term: string[] = [];
  for (const word of words) {
    const stop = NON_TERM_WORDS.has(word) || DURATION_OR_NUMBER.test(word);
    if (stop) {
      if (term.length > 0) break;
      continue;
    }
    term.push(word);
    if (term.length === 3) break;
  }
  return snake(term.join(' '));
}

const UNIT_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:mg|milligrams?)$/, 'mg'],
  [/^(?:mcg|µg|micrograms?)$/, 'mcg'],
  [/^(?:g|grams?)$/, 'g'],
  [/^(?:ml|millilit(?:re|er)s?)$/, 'ml'],
  [/^(?:mmhg)$/, 'mmHg'],
  [/^(?:mmol\/l)$/, 'mmol/L'],
  [/^(?:mg\/dl)$/, 'mg/dL'],
  [/^(?:bpm)$/, 'bpm'],
  [/^(?:kg|kilograms?)$/, 'kg'],
  [/^(?:units?|iu)$/, 'IU'],
  [/^%$/, '%'],
];

const VALUE_WITH_UNIT =
  /(?<![\d.])(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?![\d.])\s*(milligrams?|micrograms?|millilit(?:re|er)s?|kilograms?|grams?|mmol\/l|mg\/dl|mmhg|mcg|µg|mg|ml|kg|bpm|units?|iu|g|%)?(?![a-z])/g;

function canonicalUnit(unit: string): string {
  return UNIT_SYNONYMS.find(([pattern]) => pattern.test(unit))?.[1] ?? unit;
}

const ONES: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const NUMBER_RUN = new RegExp(
  `\\b(?:${[...Object.keys(ONES), ...Object.keys(TENS), 'hundred', 'thousand'].join('|')})(?:[\\s-]+(?:and[\\s-]+)?(?:${[
    ...Object.keys(ONES),
    ...Object.keys(TENS),
    'hundred',
    'thousand',
  ].join('|')}))*\\b`,
  'g',
);

/** "one thousand" → "1000", "five hundred" → "500", "twenty-five" → "25". */
function wordsToDigits(text: string): string {
  return text.replace(NUMBER_RUN, (run) => {
    let total = 0;
    let current = 0;
    for (const word of run.split(/[\s-]+/)) {
      if (word === 'and') continue;
      if (word in ONES) current += ONES[word];
      else if (word in TENS) current += TENS[word];
      else if (word === 'hundred') current = (current || 1) * 100;
      else if (word === 'thousand') {
        total += (current || 1) * 1000;
        current = 0;
      }
    }
    return String(total + current);
  });
}
