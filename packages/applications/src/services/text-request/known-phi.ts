import type { KnownPhiEntry } from '@arcaai/types';

/** The most entries one `/generate` body carries in `known_phi` (the wire contract's bound). */
export const KNOWN_PHI_MAX_ITEMS = 200;
/** The shortest value worth replacing; a one-character value would mangle ordinary text. */
export const KNOWN_PHI_MIN_VALUE_LENGTH = 2;
/**
 * The longest value replaced deterministically. A PHI-class kind may carry free text (a referral
 * letter); replacing a whole paragraph with one token would erase the clinical content the call
 * exists to process, so long or multi-line text is left to the detector's span-level pass.
 */
export const KNOWN_PHI_MAX_VALUE_LENGTH = 120;
/** How deep a structured kind's payload is walked for string leaves. */
const MAX_DEPTH = 4;

export interface KnownPhiSources {
  /** The governing `ConsultationContextSchemaVersion.definition` — read for each kind's `phiClass`. */
  definition?: unknown;
  /** The consultation's context, keyed by kind key (the shape validated at open). */
  context?: Record<string, unknown> | null;
  /** `Consultation.patientId` — the caller's own patient identifier. */
  patientId?: string | null;
  /** The clinician the consultation is written under. */
  clinician?: { firstName?: string | null; lastName?: string | null; staffId?: string | null } | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The kind keys the definition classes as PHI. */
function phiKindKeys(definition: unknown): Set<string> {
  const keys = new Set<string>();
  if (!isPlainObject(definition) || !Array.isArray(definition.kinds)) return keys;
  for (const kind of definition.kinds) {
    if (isPlainObject(kind) && kind.phiClass === 'PHI' && typeof kind.key === 'string' && kind.key.length > 0) keys.add(kind.key);
  }
  return keys;
}

/**
 * The values the gateway already KNOWS are PHI for one call, as `GenerateRequest.known_phi`.
 *
 * Order: the patient identifier, then the clinician (full name, first name, last name, staff id),
 * then every PHI-class kind's string leaves in declaration order. Only STRING leaves are taken — a
 * number in a PHI kind is far more often a clinical measurement than an identifier, and replacing
 * every "72" in a note is worse than leaving one to the detector. Values are trimmed, bounded by
 * {@link KNOWN_PHI_MIN_VALUE_LENGTH} / {@link KNOWN_PHI_MAX_VALUE_LENGTH}, de-duplicated
 * case-insensitively (first label wins) and capped at {@link KNOWN_PHI_MAX_ITEMS}.
 *
 * Pure and total: anything malformed contributes nothing. The values are PHI — callers must never
 * log them.
 */
export function collectKnownPhi(sources: KnownPhiSources): KnownPhiEntry[] {
  const entries: KnownPhiEntry[] = [];
  const seen = new Set<string>();

  const add = (label: string, raw: unknown): void => {
    if (entries.length >= KNOWN_PHI_MAX_ITEMS || typeof raw !== 'string') return;
    const value = raw.trim();
    if (value.length < KNOWN_PHI_MIN_VALUE_LENGTH || value.length > KNOWN_PHI_MAX_VALUE_LENGTH || /[\r\n]/.test(value)) return;
    const key = value.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ label, value });
  };

  const walk = (label: string, node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || entries.length >= KNOWN_PHI_MAX_ITEMS) return;
    if (typeof node === 'string') return add(label, node);
    if (Array.isArray(node)) {
      for (const item of node) walk(label, item, depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      for (const [field, value] of Object.entries(node)) walk(field, value, depth + 1);
    }
  };

  add('patient id', sources.patientId);
  const clinician = sources.clinician;
  if (clinician) {
    const first = typeof clinician.firstName === 'string' ? clinician.firstName.trim() : '';
    const last = typeof clinician.lastName === 'string' ? clinician.lastName.trim() : '';
    if (first && last) add('clinician name', `${first} ${last}`);
    add('clinician name', first);
    add('clinician name', last);
    add('staff id', clinician.staffId);
  }

  const context = isPlainObject(sources.context) ? sources.context : null;
  if (context) {
    for (const kindKey of phiKindKeys(sources.definition)) {
      if (kindKey in context) walk(kindKey, context[kindKey], 0);
    }
  }
  return entries;
}
