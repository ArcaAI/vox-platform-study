/**
 * Lane R (R1) — verification of model-proposed corrections, for the REALTIME grammar pass.
 *
 * ## This is a deliberate second copy, and it must stay one
 *
 * `apps/harness/.../consultation_realtime.py::_verified_proposals` performs the same check for
 * the durable correction node. That is not accidental duplication to be refactored away: it is a
 * PATIENT-SAFETY invariant, and an invariant enforced at one of two producers is enforced
 * nowhere. A proposal that misreports its own span would, accepted in a one-click UI, splice a
 * replacement over the wrong characters of clinical text — so every producer of proposals checks
 * the span itself, against its own source bytes, before publishing.
 *
 * The rule the two copies share, stated once here: a proposal survives only when it is
 * well-formed, carries a known category, and its own `[start, end)` in the SOURCE equals the
 * `original` it claims to replace. Anything else is DROPPED and COUNTED — never repaired.
 * Repairing a mis-specified span would be this module guessing at an edit to clinical text,
 * which is precisely what it exists not to do.
 */
import { createHash } from 'node:crypto';
import type { HarnessLiveAssistProposalDto } from '../../harness/dto/realtime-delivery.dto';

/**
 * The categories a correction may claim. Closed on purpose: an unrecognised category is a
 * malformed proposal, not a new feature to pass through. Mirrors `_CORRECTION_CATEGORIES`.
 */
const CORRECTION_CATEGORIES = new Set(['spelling', 'medicalTerm', 'drugName']);

/** First balanced-looking `{...}` span — the ```json-fence / prose-preamble tolerance. */
const JSON_BLOCK = /\{[\s\S]*\}/;

/**
 * A DETERMINISTIC id for one clinician-actionable proposal.
 *
 * Not a random uuid: the realtime executor retries a node up to its `maxAttempts`, and a retry
 * republishing the same proposal under a fresh id would resurrect one the clinician already
 * dismissed. Derived from the item's own content, so a retry is a no-op and two genuinely
 * different proposals never collide. Same construction (and same 16-hex width) as `_stable_id`.
 */
function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\x1f'), 'utf8').digest('hex').slice(0, 16);
}

/** Best-effort parse of a model's JSON reply; `null` when nothing parses, so the caller degrades. */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const candidates = [content, JSON_BLOCK.exec(content)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate. A model that returned prose is a degrade, not a throw.
    }
  }
  return null;
}

export interface VerifiedCorrections {
  proposals: HarnessLiveAssistProposalDto[];
  /** How many the model offered that could not be safely offered for one-click acceptance. */
  rejectedProposals: number;
}

/**
 * Parse and verify a correction generation's reply against the exact source it was measured on.
 *
 * An unparseable reply yields zero proposals rather than throwing: the clinician's transcript is
 * unaffected either way, and a model that answered in prose is a degraded turn, not a broken
 * contract.
 */
export function verifyCorrectionProposals(reply: string, source: string, provenance: { provider?: string; model?: string }): VerifiedCorrections {
  const parsed = parseJsonObject(reply);
  const raw = parsed?.proposals;
  if (!Array.isArray(raw)) return { proposals: [], rejectedProposals: 0 };

  const proposals: HarnessLiveAssistProposalDto[] = [];
  let rejectedProposals = 0;

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      rejectedProposals += 1;
      continue;
    }
    const { start, end, original, proposed, category, confidence, rationale } = item as Record<string, unknown>;

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      typeof original !== 'string' ||
      typeof proposed !== 'string' ||
      typeof category !== 'string' ||
      !CORRECTION_CATEGORIES.has(category) ||
      (start as number) < 0 ||
      (end as number) > source.length ||
      (start as number) >= (end as number)
    ) {
      rejectedProposals += 1;
      continue;
    }
    // THE safety check: the proposal must describe the span it actually points at.
    if (source.slice(start as number, end as number) !== original) {
      rejectedProposals += 1;
      continue;
    }
    // A no-op edit is noise in a one-click UI.
    if (proposed === original) {
      rejectedProposals += 1;
      continue;
    }

    const score = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
    proposals.push({
      proposalId: stableId('agent.grammar', String(start), String(end), original, proposed, category),
      start: start as number,
      end: end as number,
      original,
      proposed,
      category,
      confidence: score,
      rationale: typeof rationale === 'string' && rationale ? rationale : 'no rationale given',
      // Provenance for BOTH halves of how the proposal was produced, so a clinician can weigh it.
      detectedBy: 'nlp.ner',
      proposedBy: `${provenance.provider ?? 'unknown'}:${provenance.model ?? 'unknown'}`,
      // The clinician is the one who accepts. Nothing here advances this.
      status: 'PROPOSED',
    });
  }

  return { proposals, rejectedProposals };
}
