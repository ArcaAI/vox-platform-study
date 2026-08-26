import { canonicalJson, computeDefinitionChecksum } from '../consultation-context-schema/context-schema-definition';

/**
 * Classify a candidate document SHAPE against the currently published one
 * (TASK-810 Task 6), and compute the checksum that drives idempotent republish.
 *
 * Deliberately a thin sibling of `definition-diff.ts` rather than a copy of it:
 * the CANONICALISATION and the CHECKSUM come from that module unchanged, so
 * this catalog and the context-schema catalog can never disagree about whether
 * two documents are the same bytes. Only the notion of "what breaks a
 * consumer" differs, because the consumers differ.
 *
 * | Classification | Meaning | Publish behaviour |
 * |---|---|---|
 * | `IDENTICAL` | same canonical bytes | no version row, pin unmoved |
 * | `ADDITIVE`  | anything already reading this document keeps working | publishes with no acknowledgement |
 * | `BREAKING`  | a section it relied on is gone, renamed, re-formed, or newly mandatory | refused unless the admin passes `allowBreakingChange` |
 *
 * ## What counts as breaking for a DOCUMENT, and why
 *
 * - **A removed or renamed section key.** Every document already generated
 *   against the old version carries that key; a reader keyed on it (an EHR
 *   export, a sensor, a diff against a prior note) silently reads undefined. A
 *   rename is a removal plus an addition — the removal is the break.
 * - **A changed `form`.** `PROSE → STRUCTURED` turns a string into an object.
 *   Anything rendering it breaks, and so does any comparison against the
 *   previous version of the same document.
 * - **Newly REQUIRED.** This one is easy to get backwards. Making a section
 *   required tightens the decoder: the model loses the ability to say "not
 *   discussed" and must produce content. That is the exact condition D-21
 *   exists to prevent, so promoting a section to required is a clinical
 *   decision an admin acknowledges, not a quiet edit. The reverse —
 *   required → optional — is ADDITIVE: it only ever widens what the model may
 *   truthfully say.
 *
 * Conservative by construction: anything it cannot prove safe is BREAKING.
 * Under-reporting a break silently changes what a clinical document means;
 * over-reporting costs an admin a checkbox.
 */

export type ShapeChangeClassification = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING';

export interface ShapeChangeResult {
  classification: ShapeChangeClassification;
  /** Human-readable reasons, empty unless the classification is BREAKING. */
  breakingChanges: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sectionsByKey(shape: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!isPlainObject(shape) || !Array.isArray(shape.sections)) return out;
  for (const section of shape.sections) {
    if (isPlainObject(section) && typeof section.key === 'string') {
      out.set(section.key, section);
    }
  }
  return out;
}

export function classifyShapeChange(previous: unknown, next: unknown): ShapeChangeResult {
  // A first publish has nothing to break.
  if (previous == null) {
    return { classification: 'ADDITIVE', breakingChanges: [] };
  }

  if (computeDefinitionChecksum(previous) === computeDefinitionChecksum(next)) {
    return { classification: 'IDENTICAL', breakingChanges: [] };
  }

  const breakingChanges: string[] = [];
  const before = sectionsByKey(previous);
  const after = sectionsByKey(next);

  for (const [key, previousSection] of before) {
    const nextSection = after.get(key);
    if (!nextSection) {
      breakingChanges.push(`section \`${key}\` was removed (a rename is a removal plus an addition)`);
      continue;
    }
    if (previousSection.form !== nextSection.form) {
      breakingChanges.push(`section \`${key}\` changed form from ${String(previousSection.form)} to ${String(nextSection.form)}`);
    }
    if (previousSection.required !== true && nextSection.required === true) {
      breakingChanges.push(
        `section \`${key}\` became required — the model loses its ability to record that the section was not discussed (D-21)`,
      );
    }
    if (previousSection.form === 'STRUCTURED' && nextSection.form === 'STRUCTURED') {
      // The `fields` sub-schema is compared as canonical bytes rather than
      // walked: this classifier's job is to decide whether an ACKNOWLEDGEMENT
      // is needed, and a structured payload contract that moved at all is one
      // an admin should look at. Walking it would trade a false positive for a
      // possible false negative, which is the wrong trade in a clinical document.
      if (canonicalJson(previousSection.fields ?? null) !== canonicalJson(nextSection.fields ?? null)) {
        breakingChanges.push(`section \`${key}\` changed its STRUCTURED \`fields\` contract`);
      }
    }
  }

  return breakingChanges.length > 0 ? { classification: 'BREAKING', breakingChanges } : { classification: 'ADDITIVE', breakingChanges: [] };
}

/** Re-exported so callers never reach for a second checksum implementation. */
export { computeDefinitionChecksum as computeShapeChecksum } from '../consultation-context-schema/context-schema-definition';
