/**
 * TASK-1061 OD-2 — an exemplar carries STRUCTURE only.
 *
 * An approved note shown to a model as a layout example must not be able to teach it a single
 * clinical fact: another patient's note reached a new patient's pre-summary and the model copied
 * its medications and follow-up. This turns a note into its skeleton — headings (from a fixed
 * vocabulary of section names), section order, line count, bullet/numbering markers and sentence
 * shape — with every value replaced by a typed placeholder and every run of free text collapsed
 * to `<FINDING>`.
 *
 * Deterministic, no model, and conservative by construction: the ONLY words that survive are
 * section-heading words from {@link HEADING_WORDS}, on a line shaped like a heading. Everything
 * else becomes a placeholder, so a detector that misses a drug or a name costs only placeholder
 * precision (`<FINDING>` instead of `<DRUG>`), never a leak. Idempotent: a skeleton maps to
 * itself, so stripping again at use is safe.
 */

const PLACEHOLDER_KINDS = ['DRUG', 'DOSE', 'VALUE', 'DATE', 'NAME', 'FINDING'] as const;
type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

/** Section-heading vocabulary. A heading whose words are not ALL in here is content, not a heading. */
const HEADING_WORDS = new Set([
  // SOAP and its abbreviations
  's',
  'o',
  'a',
  'p',
  'subjective',
  'objective',
  'assessment',
  'plan',
  'plans',
  // history
  'history',
  'presenting',
  'present',
  'presentation',
  'complaint',
  'complaints',
  'chief',
  'reason',
  'visit',
  'encounter',
  'illness',
  'hpi',
  'hpc',
  'pc',
  'c/o',
  'background',
  'interval',
  'past',
  'medical',
  'surgical',
  'family',
  'social',
  'pmh',
  'psh',
  'fh',
  'sh',
  'dh',
  'ros',
  'review',
  'systems',
  'system',
  'symptoms',
  'symptom',
  // examination and results
  'examination',
  'examinations',
  'exam',
  'physical',
  'general',
  'o/e',
  'vitals',
  'vital',
  'signs',
  'findings',
  'finding',
  'investigations',
  'investigation',
  'ix',
  'results',
  'result',
  'labs',
  'lab',
  'laboratory',
  'tests',
  'test',
  'imaging',
  // assessment
  'impression',
  'impressions',
  'imp',
  'diagnosis',
  'diagnoses',
  'dx',
  'differential',
  'differentials',
  'ddx',
  'problem',
  'problems',
  'list',
  'clinical',
  'summary',
  'course',
  'current',
  'status',
  // plan and medications
  'management',
  'mx',
  'treatment',
  'treatments',
  'rx',
  'medication',
  'medications',
  'meds',
  'drug',
  'drugs',
  'allergies',
  'allergy',
  'prescription',
  'prescriptions',
  'orders',
  'order',
  'procedure',
  'procedures',
  'referral',
  'referrals',
  'recommendations',
  'recommendation',
  'advice',
  'counselling',
  'counseling',
  'education',
  'instructions',
  'disposition',
  'follow',
  'up',
  'followup',
  'follow-up',
  'f/u',
  'red',
  'flags',
  'flag',
  'safety',
  'netting',
  'next',
  'steps',
  'action',
  'actions',
  'goals',
  'goal',
  'outcome',
  'outcomes',
  'care',
  'notes',
  'note',
  'patient',
  'details',
  'information',
  'key',
  // joiners
  'and',
  '&',
  '/',
  'of',
  'the',
  'to',
  'for',
  'on',
  'in',
  'with',
  'or',
  '-',
]);

/** At most this many words in a heading — a longer "heading" is a sentence. */
const MAX_HEADING_WORDS = 6;

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const NUMBER = '\\d+(?:[.,]\\d+)?';
const NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|once|twice|thrice|single|double|several|few|couple)';
const DOSE_UNIT =
  '(?:mg|mcg|µg|ug|g|gm|grams?|kg|ml|mL|l|L|litres?|liters?|units?|iu|IU|meq|mEq|mmol|tabs?|tablets?|caps?|capsules?|puffs?|drops?|sachets?|ampoules?|vials?|patch(?:es)?|sprays?)(?:\\/(?:kg|day|d|hr|h|min|dose|m2))?';
const DRUG_SUFFIX =
  '[a-z]+(?:formin|pril|sartan|olol|alol|statin|dipine|azole|mycin|cillin|oxacin|cycline|prazole|tidine|gliptin|gliflozin|glutide|parin|xaban|gatran|mab|nib|vir|sone|solone|olone|triptan|lukast|afil|terol|tropium|zepam|zolam|oxetine|pramine|azepine|setron|dronate|semide|thiazide|profen|fenac|coxib|caine|tropine|phylline|insulin|aspirin|paracetamol|acetaminophen|warfarin|digoxin|levothyroxine|thyroxine|morphine|codeine|tramadol)';

/** Words that may precede a dose without being a drug name. */
const NOT_A_DRUG = new Set([
  'to',
  'at',
  'of',
  'by',
  'from',
  'in',
  'on',
  'with',
  'and',
  'or',
  'then',
  'plus',
  'take',
  'taking',
  'took',
  'give',
  'given',
  'dose',
  'doses',
  'dosage',
  'increased',
  'increase',
  'decreased',
  'decrease',
  'reduced',
  'reduce',
  'started',
  'start',
  'continue',
  'continued',
  'stop',
  'stopped',
  'was',
  'is',
  'now',
  'daily',
  'total',
  'up',
  'down',
  'about',
  'approx',
]);

/** Typed spans, in priority order. Each match is replaced by its placeholder before the next runs. */
const TYPED_SPANS: ReadonlyArray<[RegExp, PlaceholderKind]> = [
  [/\[(?:PERSON|NAME|PATIENT|DOCTOR)[A-Z_]*\d*\]/g, 'NAME'],
  [/\[[A-Z][A-Z_]*\d*\]/g, 'VALUE'],
  [/\b(?:Dr|Mr|Mrs|Ms|Miss|Mx|Prof|Sr|Sister|Nurse)\.?\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*/g, 'NAME'],
  [new RegExp(`\\b\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}\\b`, 'g'), 'DATE'],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:,?\\s+\\d{2,4})?`, 'gi'), 'DATE'],
  [new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{2,4})?`, 'gi'), 'DATE'],
  [new RegExp(`\\b${MONTH}\\s+\\d{4}\\b`, 'gi'), 'DATE'],
  [new RegExp(`\\b${WEEKDAY}\\b`, 'gi'), 'DATE'],
  [new RegExp(`(?:\\b|(?<=\\s))(?:${NUMBER}|${NUMBER_WORD})(?:\\s*(?:-|–|to)\\s*${NUMBER})?\\s*${DOSE_UNIT}(?![A-Za-z])`, 'gi'), 'DOSE'],
  [new RegExp(`\\b${DRUG_SUFFIX}\\b`, 'gi'), 'DRUG'],
  [/\d+(?:[.,:/]\d+)*\s*%?/g, 'VALUE'],
  [new RegExp(`\\b${NUMBER_WORD}\\b`, 'gi'), 'VALUE'],
];

const PLACEHOLDER = new RegExp(`<(?:${PLACEHOLDER_KINDS.join('|')})>`);
/** Sentinels used while rewriting, so a later pattern can never match inside an earlier placeholder. */
const sentinel = (kind: PlaceholderKind) => `\u0001${kind}\u0002`;

/** Turn a note into its structure-only skeleton (see the module comment). */
export function toStructureOnlyExemplar(note: string): string {
  return note
    .split(/\r?\n/)
    .map((line) => structureLine(line))
    .join('\n');
}

function structureLine(line: string): string {
  // Blank lines and pure separators (`---`, `- - -`, `***`) carry no content.
  if (!/[\p{L}\p{N}<]/u.test(line)) return line;

  const heading = wholeLineHeading(line);
  if (heading !== null) return heading;

  // Leading indentation + bullet / numbering marker survive as shape.
  const marker = /^(\s*(?:#{1,6}\s+|[-*•+]\s+|\(?\d{1,2}[.)]\s+|\(?[a-z][.)]\s+)?)(.*)$/.exec(line)!;
  const prefix = marker[1] ?? '';
  let body = marker[2] ?? '';

  // An inline heading — `Assessment: stable angina` — keeps its label.
  const inline = /^((?:\*\*|__)?([A-Za-z][^:*_]{0,59}?)(?:\*\*|__)?\s*:(?:\*\*|__)?)\s*(.*)$/.exec(body);
  let label = '';
  if (inline && isHeadingText(inline[2] ?? '')) {
    label = `${inline[1]} `;
    body = inline[3] ?? '';
  }
  const skeleton = skeletonOf(body);
  return `${prefix}${label}${skeleton}`.trimEnd();
}

/** A line that is ONLY a heading (`Plan:`, `## Plan`, `**Assessment**`), returned verbatim, else `null`. */
function wholeLineHeading(line: string): string | null {
  const match = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?([A-Za-z][^:*_#]{0,59}?)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/.exec(line);
  if (!match) return null;
  return isHeadingText(match[1] ?? '') ? line : null;
}

function isHeadingText(text: string): boolean {
  const words = text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0 || words.length > MAX_HEADING_WORDS) return false;
  return words.every((word) => HEADING_WORDS.has(word) || HEADING_WORDS.has(word.replace(/[^a-z/&-]/g, '')));
}

/** A run of text as typed placeholders, one group per sentence, free text collapsed to `<FINDING>`. */
function skeletonOf(body: string): string {
  if (body.trim().length === 0) return '';
  let text = body.replace(new RegExp(PLACEHOLDER.source, 'g'), (match) => sentinel(match.slice(1, -1) as PlaceholderKind));
  for (const [pattern, kind] of TYPED_SPANS) text = text.replace(pattern, () => sentinel(kind));
  // A word immediately before a dose is the drug it doses, unless it is a verb or a joiner.
  text = text.replace(new RegExp(`([\\p{L}][\\p{L}-]+)(\\s+)(?=${sentinel('DOSE')})`, 'gu'), (match, word: string, space: string) =>
    NOT_A_DRUG.has(word.toLowerCase()) ? match : `${sentinel('DRUG')}${space}`,
  );

  const sentences = text.split(/(?<=[.!?;])\s+/).filter((sentence) => sentence.trim().length > 0);
  return sentences
    .map((sentence) => {
      const terminator = /[.!?;]\s*$/.exec(sentence)?.[0].trim() ?? '';
      const tokens: string[] = [];
      for (const piece of sentence.split(/(\u0001[A-Z]+\u0002)/)) {
        const kind = /^\u0001([A-Z]+)\u0002$/.exec(piece)?.[1];
        if (kind) {
          push(tokens, `<${kind}>`);
        } else if (/[\p{L}\p{N}]/u.test(piece)) {
          push(tokens, '<FINDING>');
        }
      }
      return tokens.length > 0 ? `${tokens.join(' ')}${terminator}` : '';
    })
    .filter((sentence) => sentence.length > 0)
    .join(' ');
}

/** Append a placeholder, collapsing a repeat of the one before it. */
function push(tokens: string[], placeholder: string): void {
  if (tokens[tokens.length - 1] !== placeholder) tokens.push(placeholder);
}
