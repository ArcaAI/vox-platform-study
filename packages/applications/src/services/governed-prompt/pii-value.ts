/**
 * TASK-1047 (owner decision 2026-10-06, "Validate span values") — does a PII span found in a prompt
 * PIECE carry an actual value?
 *
 * Authoring-time screening runs GLiNER2 PII detection over instruction text, and instruction text
 * legitimately NAMES PII categories ("replace any personal name, identifier, address, phone number or
 * email with a placeholder"). The detector labels those words — `email` at 0.968 on the seeded
 * note-finalisation instruction — which blocked the core note agent from ever being governed. A
 * template that carries real patient data shows a VALUE: an address with `@`, digits in a phone /
 * ID / date, a capitalised proper name. Only those count; a category word never does.
 */

/** Generic words a name-labelled span may be that are never a person's name. */
const NOT_A_NAME = new Set([
  'name', 'names', 'full', 'first', 'last', 'middle', 'surname', 'patient', 'patients', 'doctor', 'doctors',
  'dr', 'clinician', 'clinicians', 'person', 'persons', 'people', 'user', 'users', 'the', 'a', 'an', 'mr', 'mrs',
  'ms', 'miss', 'sir', 'madam', 'nurse', 'physician', 'consultant', 'family', 'relative', 'caregiver',
  'speaker', 'name_placeholder',
  // Languages: instructions name the note language ("write in English"); the detector reads it as a person.
  'english', 'malayalam', 'hindi', 'tamil', 'kannada', 'telugu', 'marathi', 'bengali', 'gujarati', 'punjabi',
  'urdu', 'arabic', 'french', 'spanish', 'german', 'chinese', 'mandarin', 'japanese',
]); // prettier-ignore

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const BRACKET_PLACEHOLDER = /^\s*\[[A-Z_ ]+\]\s*$/;

function digitCount(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

/**
 * A person's name never contains a digit; GLiNER2 labels drug + dose in example notes
 * ("Shelcal 500 mg") as `full_name` (TASK-1047 live validation: 31 of 31 template hits).
 */
function hasProperName(text: string): boolean {
  if (digitCount(text) > 0) return false;
  return text
    .split(/[\s,]+/)
    .map((token) => token.replace(/[.'’]+$/g, ''))
    .some((token) => /^[A-Z][a-z'’-]{1,}$/.test(token) && !NOT_A_NAME.has(token.toLowerCase()));
}

/** `true` when `text`, labelled `label` by the PII detector, looks like real personal data. */
export function isPiiValue(label: string, text: string): boolean {
  if (!text || BRACKET_PLACEHOLDER.test(text)) return false;
  const kind = label.toLowerCase();
  if (kind.includes('email')) return EMAIL.test(text);
  if (/(phone|mobile|fax|telephone)/.test(kind)) return digitCount(text) >= 7;
  if (/(date|birth|dob)/.test(kind)) return digitCount(text) >= 1;
  if (/(address|street|postal|zip)/.test(kind)) return digitCount(text) >= 1;
  if (/(name|person)/.test(kind)) return hasProperName(text);
  if (/(id|number|account|card|iban|passport|licen|ssn|tax|mrn|record|routing)/.test(kind)) return digitCount(text) >= 4;
  return digitCount(text) >= 1 || text.includes('@');
}

/**
 * Direct identifiers point at one person on their own (name, contact, identifier, street address);
 * quasi-identifiers (dates, ages, places, facilities, anything unknown) do not — under HIPAA Safe
 * Harbor a date only identifies alongside the individual it belongs to.
 */
export function piiIdentifierClass(label: string): 'direct' | 'quasi' {
  const kind = label.toLowerCase();
  if (/(date|birth|dob|age|city|state|country|region|location|facility|gender|nationality|religion)/.test(kind)) return 'quasi';
  if (
    /(email|phone|mobile|fax|telephone|name|person|address|street|id|number|account|card|iban|passport|licen|ssn|tax|mrn|record|routing)/.test(kind)
  ) {
    return 'direct';
  }
  return 'quasi';
}

/**
 * `true` when a name-like span starts or ends inside a word of its region — a window cut, e.g. `ady English`
 * from "Already English". Guardrail's windows overlap by 256 characters, so a real value cut at one window's
 * edge is also seen whole in the neighbouring window; the fragment itself is never a value.
 */
export function isNameFragment(label: string, regionText: string | undefined, start: number, end: number): boolean {
  if (regionText === undefined || !/(name|person)/.test(label.toLowerCase())) return false;
  const isLetter = (ch: string | undefined) => ch !== undefined && /\p{L}/u.test(ch);
  return isLetter(regionText[start - 1]) || isLetter(regionText[end]);
}
