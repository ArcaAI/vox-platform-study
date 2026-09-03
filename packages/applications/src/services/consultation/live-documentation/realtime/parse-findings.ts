/**
 * Lane N — parse a model's IMPORTANT-FINDINGS reply.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not decide what is important. The owner's specification assigns that to the tenant
 * admin's instruction, so there is no severity ladder here, no red-flag vocabulary, no
 * allergy-alert class and no importance threshold — and `important-findings.test.ts` asserts
 * their absence rather than trusting a reviewer to notice one arriving later. The `type` on every
 * finding is whatever label the tenant's own instruction told the model to assign, and this
 * module neither validates it against a list nor supplies one when it is missing.
 *
 * ## What it does do, and why each rule is a safety rule
 *
 * A finding that cannot be ANCHORED cannot be highlighted, and a finding that is fabricated is
 * worse than one that is missing. So:
 *
 *  - a row with no `text` is DROPPED. `groundEntitiesToNote` locates a finding by its surface form
 *    in the rendered note; with no surface form there is nothing to locate, and keeping the row
 *    would put an un-anchorable claim on the feed;
 *  - a row with no `type` is DROPPED rather than defaulted. Inventing a label would be this file
 *    answering the question the owner assigned to the tenant admin;
 *  - `confidence` is kept only when it is a real 0..1 number, so a model returning `"high"` yields
 *    an absent score rather than a coerced one;
 *  - offsets the model reports are DISCARDED. They index whatever the model thinks it read;
 *    `groundEntitiesToNote` re-derives `start`/`end` against the rendered note, which is the only
 *    string the client's highlight offsets may index. Carrying the model's numbers through would
 *    silently mis-highlight clinical text.
 *  - `limit` caps how many cross the wire. A bounded-output guard, not a ranking policy: it never
 *    decides WHICH findings matter, only how many a single turn may publish.
 *
 * Nothing parses ⇒ an EMPTY list. An empty highlight set is a visible nothing; a guessed one is a
 * clinical claim the tenant's instruction never made.
 */
import type { LiveSummaryEntityDto } from '../dto';

/** Default cap when the node authors no `maxFindings`. See the module docstring. */
export const DEFAULT_MAX_FINDINGS = 25;

const JSON_BLOCK = /\{[\s\S]*\}/;

/** Best-effort parse of the model's JSON reply, tolerating a ```json fence or a prose preamble. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const candidates = [content, JSON_BLOCK.exec(content ?? '')?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate; an unparseable reply yields an empty list, never a guess.
    }
  }
  return null;
}

/**
 * The findings a client can actually anchor a highlight to, capped at `limit`.
 *
 * Shaped as `LiveSummaryEntityDto` on purpose: that is what lets a finding travel the highlight
 * path already built (`groundEntitiesToNote` → `reanchorAnnotations`) with no second
 * anchoring mechanism to keep in step.
 */
export function parseImportantFindings(content: string, limit: number = DEFAULT_MAX_FINDINGS): LiveSummaryEntityDto[] {
  const parsed = parseJsonObject(content);
  const raw = parsed?.findings;
  if (!Array.isArray(raw)) return [];

  const findings: LiveSummaryEntityDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    const type = typeof row.type === 'string' ? row.type.trim() : '';
    if (!text || !type) continue;

    const confidence = typeof row.confidence === 'number' && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : undefined;
    // No `start`/`end`: the note offsets are re-derived by `groundEntitiesToNote` against the
    // rendered running summary, which is the only string those offsets may index.
    findings.push({ text, type, ...(confidence === undefined ? {} : { confidence }) });
    if (findings.length >= limit) break;
  }
  return findings;
}
