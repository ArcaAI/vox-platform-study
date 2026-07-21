/**
 * Edit-capture delta utility.
 *
 * Computes the draft→edit delta that gets stamped onto the existing
 * `ContextItemVersion.contentDiff` (a compact unified line diff) and
 * `ContextItemVersion.fieldChanges` (a per-SOAP-section old/new map, with a
 * whole-document fallback). Intentionally dependency-light (hand-rolled LCS line
 * diff) so the summary write path pulls in no new packages, and pure so it is
 * trivially unit-testable. NO schema change — both columns already exist.
 */

/** Per-field old/new pair captured in `fieldChanges`. */
export interface FieldChange {
  old: string | null;
  new: string | null;
}

/** The delta written onto a `ContextItemVersion` on edit / sign. */
export interface ContentDelta {
  /** Unified line diff (`  ` context, `- ` removed, `+ ` added), or null when unchanged. */
  contentDiff: string | null;
  /** Per-SOAP-section (or whole-document) changes, or null when unchanged. */
  fieldChanges: Record<string, FieldChange> | null;
}

/** The canonical SOAP section names `fieldChanges` keys on. */
const SOAP_SECTIONS = ['subjective', 'objective', 'assessment', 'plan'] as const;

/**
 * Normalize a line to a canonical SOAP header name, or null when it is not a
 * section header. Tolerates the common heading shapes (`Subjective:`,
 * `## Assessment`, `**Plan**`, `S O A P` words) by stripping leading markdown /
 * list markers and trailing punctuation before matching.
 */
function canonicalSoapHeader(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^[#*>\-\s]+/, '')
    .replace(/[:*\s]+$/, '')
    .trim()
    .toLowerCase();
  return (SOAP_SECTIONS as readonly string[]).includes(stripped) ? stripped : null;
}

/**
 * Group a note's lines under their SOAP section headers. Returns null when no
 * recognizable SOAP header is present (the caller then uses the whole-document
 * fallback). Content before the first header is ignored for the section map.
 */
function parseSoapSections(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  const buckets: Record<string, string[]> = {};
  let current: string | null = null;
  let found = false;

  for (const line of lines) {
    const header = canonicalSoapHeader(line);
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
 */
export function diffContent(oldContent: string | null | undefined, newContent: string | null | undefined): ContentDelta {
  const oldStr = oldContent ?? '';
  const newStr = newContent ?? '';

  if (oldStr === newStr) {
    return { contentDiff: null, fieldChanges: null };
  }

  const contentDiff = buildLineDiff(oldStr, newStr);

  const oldSections = parseSoapSections(oldStr);
  const newSections = parseSoapSections(newStr);

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

  // Whole-document fallback: unparseable notes, or a change outside any SOAP
  // section (e.g. a preamble edit) where the section map came back unchanged.
  if (!fieldChanges) {
    fieldChanges = { document: { old: oldStr, new: newStr } };
  }

  return { contentDiff, fieldChanges };
}
