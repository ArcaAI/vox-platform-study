'use client';

/**
 * TASK-797 W2 — spelling / medical-term / drug-name correction review.
 *
 * Implements the four rendering rules TASK-796 declared as SAFETY PROPERTIES, not styling:
 *
 *  1. NEVER auto-apply. `status` advances only on an explicit click, one proposal at a time —
 *     there is deliberately no "accept all".
 *  2. VERIFY the local text's SHA-256 against `corrections.textSha256` before applying. The
 *     proposals index byte offsets into one exact revision; if the note has moved, those
 *     offsets address characters that are no longer there and applying one would splice a drug
 *     name or a dose over the wrong span. On mismatch this REFUSES, says so, and re-requests
 *     via `onStale` — it does not fall back to a best-effort match.
 *  3. Key by `proposalId` (content-derived SHA-256, stable across Temporal activity retries),
 *     never by array index — so a rejected proposal stays rejected when the same envelope is
 *     re-delivered in a different order.
 *  4. Show BOTH provenance halves: what found the span, and what proposed the replacement.
 *
 * This component mutates nothing. `onAccept` hands the corrected text back to the caller,
 * which in the case note is the clinician's own edit buffer — so an accepted correction is a
 * clinician edit, never a machine write, and the R5 two-writer contract stays intact.
 */

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconCheck, IconPencilExclamation, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { applyProposal, verifiedProposals } from '../../lib/correction-proposals';
import { sha256Hex } from '../../lib/text-digest';
import type { CorrectionCategory, CorrectionProposal, CorrectionsEnvelope } from '../../api/live-assist';

const CATEGORY_LABEL: Record<CorrectionCategory, string> = {
  spelling: 'Spelling',
  medicalTerm: 'Medical term',
  drugName: 'Drug name',
};

const STALE_MESSAGE = 'The note has changed since these corrections were produced, so their positions no longer match it. Nothing was applied.';

export interface CorrectionProposalsPanelProps {
  /** The corrections envelope from the `live-assist` stream. `null` renders nothing. */
  corrections: CorrectionsEnvelope | null;
  /** The CURRENT note text — the buffer while editing, the persisted draft otherwise. */
  text: string;
  /** Receives the corrected text for one accepted proposal. Called only after the digest gate passes. */
  onAccept: (nextText: string) => void;
  /** Re-request the proposals for the current text (796 rule 2's "and re-request"). */
  onStale?: () => void;
  /**
   * TASK-814 §2b — fires alongside `onAccept`, once the digest gate passes, with the proposal
   * marked `status: 'ACCEPTED'`. Accepting a correction here already IS the clinician's
   * judgement that it is right, so there is deliberately no second "promote" control — the
   * caller threads this into the promotion-over-the-raw-transcript path (TASK-812 DD-8)
   * independently of the note-buffer write `onAccept` performs.
   */
  onProposalAccepted?: (proposal: CorrectionProposal) => void;
  /** When set, both actions are disabled and this reason is shown (rule 11 §5). */
  disabledReason?: string | null;
}

export function CorrectionProposalsPanel({ corrections, text, onAccept, onStale, onProposalAccepted, disabledReason = null }: CorrectionProposalsPanelProps) {
  /** Ids the clinician has decided on. Ids, not indexes — 796 rule 3. */
  const [decided, setDecided] = useState<readonly string[]>([]);
  /** Set once the digest gate has failed: the whole envelope is stale, not just one proposal. */
  const [stale, setStale] = useState(false);

  const offered = useMemo(() => {
    const open = (corrections?.proposals ?? []).filter((proposal) => !decided.includes(proposal.proposalId));
    // A second, local check: offsets must still slice out their own `original`. The digest gate
    // is authoritative, but this keeps a plainly-broken proposal off the screen entirely.
    return verifiedProposals(text, open);
  }, [corrections, text, decided]);

  if (!corrections || offered.length === 0) return null;

  function decide(proposal: CorrectionProposal) {
    setDecided((current) => [...current, proposal.proposalId]);
  }

  async function accept(proposal: CorrectionProposal) {
    // 796 rule 2. Checked at click time against the text as it stands right now.
    const digest = await sha256Hex(text);
    if (digest !== corrections?.textSha256) {
      setStale(true);
      toast.error(STALE_MESSAGE);
      onStale?.();
      return;
    }

    const { text: next } = applyProposal(text, proposal, offered);
    decide(proposal);
    onAccept(next);
    onProposalAccepted?.({ ...proposal, status: 'ACCEPTED' });
  }

  return (
    <section className="border-t pt-3" aria-label="Suggested corrections">
      <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-medium">
        Suggested corrections
        <span className="bg-ai/10 text-ai rounded px-1 text-xs font-medium">AI</span>
        <span className="font-normal">
          {offered.length} proposal{offered.length === 1 ? '' : 's'} — nothing has been changed in your note.
        </span>
      </div>
      {disabledReason ? <p className="text-muted-foreground mb-1.5 text-xs">{disabledReason}</p> : null}

      {stale ? (
        <Alert variant="destructive" className="mb-2">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>These corrections are out of date</AlertTitle>
          <AlertDescription>{STALE_MESSAGE}</AlertDescription>
        </Alert>
      ) : null}

      <ul className="flex list-none flex-col gap-2">
        {offered.map((proposal) => (
          <li key={proposal.proposalId} className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <del className="text-muted-foreground decoration-destructive/70">{proposal.original}</del>
                <span aria-hidden>→</span>
                <ins className="font-medium no-underline">{proposal.proposed}</ins>
                <Badge variant="outline">{CATEGORY_LABEL[proposal.category] ?? proposal.category}</Badge>
              </p>
              <p className="text-muted-foreground text-xs">{proposal.rationale}</p>
              {/* 796 rule 4: both halves, so the clinician can weigh the proposal. */}
              <p className="text-muted-foreground text-xs">
                found by <span className="font-mono">{proposal.detectedBy}</span> · proposed by <span className="font-mono">{proposal.proposedBy}</span> ·{' '}
                {Math.round(proposal.confidence * 100)}% confidence
              </p>
            </div>
            {/* Reject is exactly as reachable as Accept: same row, same size, same enabled state.
                Once the set is known stale, Accept is withdrawn entirely — but Reject stays, so
                the clinician can still clear a proposal they have judged. */}
            <div className="flex shrink-0 items-center gap-1.5">
              {stale ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!!disabledReason}
                  aria-label={`Accept correction: ${proposal.original} to ${proposal.proposed}`}
                  onClick={() => void accept(proposal)}
                >
                  <IconCheck aria-hidden />
                  Accept
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!!disabledReason}
                aria-label={`Reject correction: ${proposal.original} to ${proposal.proposed}`}
                onClick={() => decide(proposal)}
              >
                <IconX aria-hidden />
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
        <IconPencilExclamation aria-hidden className="size-3.5" />
        Each correction is applied only when you accept it.
      </p>
    </section>
  );
}
