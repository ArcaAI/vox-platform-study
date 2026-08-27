/**
 * Edit-capture delta utility.
 *
 * Computes the draft→edit delta that gets stamped onto the existing
 * `ContextItemVersion.contentDiff` (a compact unified line diff) and
 * `ContextItemVersion.fieldChanges` (a per-SECTION old/new map, with a
 * whole-document fallback). Intentionally dependency-light (hand-rolled LCS line
 * diff) so the summary write path pulls in no new packages, and pure so it is
 * trivially unit-testable. NO schema change — both columns already exist.
 *
 * ## Why the section vocabulary is a PARAMETER (TASK-810 carry-over A)
 *
 * This module used to own a private four-key tuple —
 * `['subjective','objective','assessment','plan']` — and match note headings
 * against it. That is the same structural commitment to exactly four sections
 * that TASK-810 removed from the live-flush plane, surviving here only because
 * it sits on a DIFFERENT call graph: the FINAL summary write (clinician edit and
 * sign-off in `summary.service.ts`), not the live loop.
 *
 * The vocabulary now arrives as a COMPILED DOCUMENT TEMPLATE, so a tenant whose
 * shape is a ten-section discharge summary gets a ten-key `fieldChanges` map
 * through identical code. Nothing in this file knows the word SOAP.
 *
 * ## The fallback is preserved, and it is what "no shape" means
 *
 * `fieldChanges` always documented a whole-document fallback for a note that
 * does not parse into sections. That fallback is now ALSO the answer when no
 * template resolves at all: without a shape this module has no section
 * vocabulary, and inventing one — by quietly reinstating the four SOAP names —
 * would key a tenant's clinical edit history on sections their template never
 * declared. A whole-document delta is less granular but always true.
 *
 * Matching accepts a section's TITLE ("Follow-up") *and* its KEY ("follow_up"),
 * for the reason `document-shape-parser.ts` gives: a model handed a JSON-shaped
 * instruction that falls back to prose emits whichever of the two the
 * instruction named last. The emitted map is always keyed on the KEY, so the
 * persisted shape of `fieldChanges` is stable no matter which heading the model
 * wrote — and, for the platform SOAP shape, byte-identical to what this module
 * emitted when the four names were hardcoded.
 */
import type { CompiledDocumentTemplate } from '../../document-template/document-template-compiler';

/** Per-field old/new pair captured in `fieldChanges`. */
export interface FieldChange {
  old: string | null;
  new: string | null;
}

/** The delta written onto a `ContextItemVersion` on edit / sign. */
export interface ContentDelta {
  /** Unified line diff (`  ` context, `- ` removed, `+ ` added), or null when unchanged. */
  contentDiff: string | null;
  /** Per-section (or whole-document) changes, or null when unchanged. */
  fieldChanges: Record<string, FieldChange> | null;
}

/**
 * Lower-cased heading keyword (title OR key) → the section KEY to report under.
 * Null when the template supplies no sections to match against.
 */
type SectionLookup = Map<string, string>;

function sectionLookupFor(compiled: CompiledDocumentTemplate | null | undefined): SectionLookup | null {
  if (!compiled || compiled.checklist.length === 0) return null;

  const lookup: SectionLookup = new Map();
  for (const entry of compiled.checklist) {
    lookup.set(entry.title.trim().toLowerCase(), entry.key);
    lookup.set(entry.key.trim().toLowerCase(), entry.key);
  }
  return lookup;
}

/**
 * Normalize a line to one of the template's section keys, or null when it is not
 * a section header. Tolerates the common heading shapes (`Subjective:`,
 * `## Assessment`, `**Plan**`) by stripping leading markdown / list markers and
 * trailing punctuation before matching. Unchanged from the SOAP version except
 * for what it matches AGAINST.
 */
function canonicalSectionKey(line: string, lookup: SectionLookup): string | null {
  const stripped = line
    .trim()
    .replace(/^[#*>\-\s]+/, '')
    .replace(/[:*\s]+$/, '')
    .trim()
    .toLowerCase();
  return lookup.get(stripped) ?? null;
}

/**
 * Group a note's lines under their section headers. Returns null when no
 * recognizable header is present (the caller then uses the whole-document
 * fallback). Content before the first header is ignored for the section map.
 */
function parseSections(text: string, lookup: SectionLookup): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  const buckets: Record<string, string[]> = {};
  let current: string | null = null;
  let found = false;

  for (const line of lines) {
    const header = canonicalSectionKey(line, lookup);
    if (header) {
      current = header;
      found = true;
      buckets[current] ??= [];
      continue;
    }
    if (current) buckets[current].push(line);
  }

  if (!found) return null;

  const sections: Record<string, string> = {};
  for (const [key, value] of Object.entries(buckets)) {
    sections[key] = value.join('\n').trim();
  }
  return sections;
}

/**
 * Hand-rolled LCS line diff → compact unified text. Context lines are prefixed
 * `  `, removals `- `, additions `+ `. Clinical notes are small, so the O(n·m)
 * table is fine (the DNA corpus is independently capped upstream).
 */
function buildLineDiff(oldText: string, newText: string): string {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/**
 * Compute the edit-capture delta between two note contents. Returns
 * `{ contentDiff: null, fieldChanges: null }` when the content is unchanged
 * (null/undefined are treated as the empty string).
 *
 * @param compiled The tenant's resolved, pinned document shape. Omit (or pass
 *   null) when none resolves — `fieldChanges` then carries the whole-document
 *   delta rather than guessing a section vocabulary.
 */
export function diffContent(
  oldContent: string | null | undefined,
  newContent: string | null | undefined,
  compiled?: CompiledDocumentTemplate | null,
): ContentDelta {
  const oldStr = oldContent ?? '';
  const newStr = newContent ?? '';

  if (oldStr === newStr) {
    return { contentDiff: null, fieldChanges: null };
  }

  const contentDiff = buildLineDiff(oldStr, newStr);

  const lookup = sectionLookupFor(compiled);
  const oldSections = lookup ? parseSections(oldStr, lookup) : null;
  const newSections = lookup ? parseSections(newStr, lookup) : null;

  let fieldChanges: Record<string, FieldChange> | null = null;
  if (oldSections || newSections) {
    const keys = new Set([...Object.keys(oldSections ?? {}), ...Object.keys(newSections ?? {})]);
    const changes: Record<string, FieldChange> = {};
    for (const key of keys) {
      const before = oldSections?.[key] ?? null;
      const after = newSections?.[key] ?? null;
      if (before !== after) changes[key] = { old: before, new: after };
    }
    if (Object.keys(changes).length > 0) fieldChanges = changes;
  }

  // Whole-document fallback, now covering three cases: no template resolved,
  // an unparseable note, and a change outside any recognised section (e.g. a
  // preamble edit) where the section map came back unchanged.
  if (!fieldChanges) {
    fieldChanges = { document: { old: oldStr, new: newStr } };
  }

  return { contentDiff, fieldChanges };
}
