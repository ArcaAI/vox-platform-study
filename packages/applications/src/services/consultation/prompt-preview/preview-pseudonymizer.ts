/**
 * The Prompt Inspector's mirror of `apps/text`'s request-scoped `Pseudonymizer`
 * (`apps/text/src/text/services/pseudonymizer.py`), for the PREVIEW only: it shows what a cloud
 * provider would receive. The real replacement happens in `apps/text`, on every cloud call.
 *
 * Same grammar `[<LABEL>_<n>]` (LABEL the uppercase snake of the taxonomy label, n per label,
 * stable per distinct value — case-insensitive, whitespace-normalised), same precedence (a known
 * value first, then the longer span, never one value tokenised twice), and span offsets read as
 * CODE POINTS, which is what the Python service emits.
 *
 * The token → value map lives on the instance and dies with the preview; it is never logged.
 */

/** One detected identifier, in CODE-POINT offsets of the text it was found in. */
export interface PreviewPiiSpan {
  label: string;
  start: number;
  end: number;
}

/** `date of-birth` → `DATE_OF_BIRTH`. */
export function tokenLabel(label: string): string {
  return (
    label
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase() || 'PII'
  );
}

function normalise(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive, whitespace-tolerant, never matching inside a longer word (Unicode `\w`, as Python). */
function valuePattern(value: string): RegExp {
  const parts = value.split(/\s+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${parts.join('\\s+')}(?![\\p{L}\\p{N}_])`, 'giu');
}

/** UTF-16 index of every code-point position of `text` (and of its end). */
function codePointIndex(text: string): number[] {
  const index: number[] = [];
  let unit = 0;
  for (const char of text) {
    index.push(unit);
    unit += char.length;
  }
  index.push(unit);
  return index;
}

interface Candidate {
  start: number;
  priority: number;
  negLength: number;
  label: string;
}

export class PreviewPseudonymizer {
  /** Detections by taxonomy label, counted whether or not they are replaced. */
  readonly detected: Record<string, number> = {};
  /** Occurrences replaced by a token. */
  redacted = 0;

  private readonly patterns: Array<{ label: string; pattern: RegExp }>;
  private readonly tokenByKey = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(knownPhi: ReadonlyArray<readonly [string, string]>) {
    const known = knownPhi.filter(([, value]) => value.trim().length > 0).sort((a, b) => b[1].length - a[1].length);
    this.patterns = known.map(([label, value]) => ({ label, pattern: valuePattern(value) }));
  }

  /** Detect only — the LOCAL path: counted for audit, nothing replaced. */
  count(text: string, spans: readonly PreviewPiiSpan[]): void {
    for (const interval of this.intervals(text, spans)) this.detected[interval.label] = (this.detected[interval.label] ?? 0) + 1;
  }

  /** `text` with every detected identifier replaced by its token. */
  pseudonymize(text: string, spans: readonly PreviewPiiSpan[]): string {
    const intervals = this.intervals(text, spans);
    if (intervals.length === 0) return text;
    let out = '';
    let cursor = 0;
    for (const { start, end, label } of intervals) {
      out += text.slice(cursor, start) + this.token(label, text.slice(start, end));
      cursor = end;
      this.detected[label] = (this.detected[label] ?? 0) + 1;
      this.redacted += 1;
    }
    return out + text.slice(cursor);
  }

  /** Non-overlapping intervals, in UTF-16 indices, chosen exactly as the Python service chooses them. */
  private intervals(text: string, spans: readonly PreviewPiiSpan[]): Array<{ start: number; end: number; label: string }> {
    const units = codePointIndex(text);
    const toUnit = (codePoint: number): number => units[Math.max(0, Math.min(codePoint, units.length - 1))]!;
    const candidates: Candidate[] = [];
    for (const { label, pattern } of this.patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        candidates.push({ start: match.index, priority: 0, negLength: -match[0].length, label });
      }
    }
    const codePoints = units.length - 1;
    for (const span of spans) {
      const start = toUnit(Math.max(0, span.start));
      const end = toUnit(Math.min(codePoints, span.end));
      if (end > start && text.slice(start, end).trim().length > 0) {
        candidates.push({ start, priority: 1, negLength: -(end - start), label: span.label });
      }
    }
    candidates.sort((a, b) => a.start - b.start || a.priority - b.priority || a.negLength - b.negLength || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const chosen: Array<{ start: number; end: number; label: string }> = [];
    let lastEnd = -1;
    for (const candidate of candidates) {
      if (candidate.start < lastEnd) continue;
      const end = candidate.start - candidate.negLength;
      chosen.push({ start: candidate.start, end, label: candidate.label });
      lastEnd = end;
    }
    return chosen;
  }

  private token(label: string, value: string): string {
    const head = tokenLabel(label);
    const key = `${head}\u0000${normalise(value)}`;
    let token = this.tokenByKey.get(key);
    if (token === undefined) {
      const next = (this.counters.get(head) ?? 0) + 1;
      this.counters.set(head, next);
      token = `[${head}_${next}]`;
      this.tokenByKey.set(key, token);
    }
    return token;
  }
}
