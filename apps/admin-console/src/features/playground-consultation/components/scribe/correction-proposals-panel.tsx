'use client';

/**
 * TASK-797 W2 — spelling / medical-term / drug-name correction review.
 *
 * A correction is a PROPOSAL, and that is a patient-safety property rather than a
 * preference: a system that silently rewrites a drug name or a dose is a defect. So this
 * panel
 *
 *   - never renders a proposal as though it had been applied (the harness returns the source
 *     byte-identical with `applied: false`, and says so on screen);
 *   - requires an explicit click per proposal, one at a time — there is deliberately no
 *     "accept all";
 *   - gives Reject exactly the same prominence and reach as Accept;
 *   - attributes every proposal to BOTH the detector that found the span and the model that
 *     proposed the replacement, so a clinician can weigh it;
 *   - mutates nothing. `onAccept` hands the corrected text back to the caller, which decides
 *     where it goes (in the case note that is the clinician's own edit buffer).
 *
 * Staleness is handled structurally rather than by bookkeeping: the offered set is DERIVED
 * from the `text` prop on every render via `verifiedProposals`, so a proposal whose offsets
 * stop matching — because the clinician typed, or because an earlier correction shifted the
 * text — simply stops being offered. See `../../lib/correction-proposals.ts`.
 */

import { useMemo, useState } from 'react';
import { IconCheck, IconPencilExclamation, IconX } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { applyProposal, verifiedProposals } from '../../lib/correction-proposals';
import type { CorrectionCategory, CorrectionProposal, CorrectionProposalSet } from '../../api/pending-contracts';

const CATEGORY_LABEL: Record<CorrectionCategory, string> = {
  spelling: 'Spelling',
  medicalTerm: 'Medical term',
  drugName: 'Drug name',
};

/** Stable identity for a proposal across re-derivations (offsets shift; this pair does not). */
const proposalKey = (proposal: CorrectionProposal) => `${proposal.original}→${proposal.proposed}@${proposal.detectedBy}`;

export interface CorrectionProposalsPanelProps {
  /** The harness proposal set. `null` renders nothing. */
  proposalSet: CorrectionProposalSet | null;
  /** The text the proposals are checked against — the CURRENT note text, not the original. */
  text: string;
  /** Receives the corrected text for one accepted proposal. Called only on an explicit click. */
  onAccept: (nextText: string) => void;
  /** When set, both actions are disabled and this reason is shown (rule 11 §5). */
  disabledReason?: string | null;
}

export function CorrectionProposalsPanel({ proposalSet, text, onAccept, disabledReason = null }: CorrectionProposalsPanelProps) {
  const [decided, setDecided] = useState<readonly string[]>([]);

  const offered = useMemo(() => {
    const open = (proposalSet?.proposals ?? []).filter((proposal) => !decided.includes(proposalKey(proposal)));
    return verifiedProposals(text, open);
  }, [proposalSet, text, decided]);

  if (!proposalSet || offered.length === 0) return null;

  function decide(proposal: CorrectionProposal) {
    setDecided((current) => [...current, proposalKey(proposal)]);
  }

  function accept(proposal: CorrectionProposal) {
    // Throws rather than best-effort splicing if the proposal has drifted. It cannot have —
    // `offered` was verified against this same `text` — but the guard is the point.
    const { text: next } = applyProposal(text, proposal, offered);
    decide(proposal);
    onAccept(next);
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
      <ul className="flex list-none flex-col gap-2">
        {offered.map((proposal) => (
          <li key={proposalKey(proposal)} className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <del className="text-muted-foreground decoration-destructive/70">{proposal.original}</del>
                <span aria-hidden>→</span>
                <ins className="font-medium no-underline">{proposal.proposed}</ins>
                <Badge variant="outline">{CATEGORY_LABEL[proposal.category] ?? proposal.category}</Badge>
              </p>
              <p className="text-muted-foreground text-xs">{proposal.rationale}</p>
              {/* Provenance: the detector AND the proposer, so the clinician can weigh it. */}
              <p className="text-muted-foreground text-xs">
                found by <span className="font-mono">{proposal.detectedBy}</span> · proposed by <span className="font-mono">{proposal.proposedBy}</span> ·{' '}
                {Math.round(proposal.confidence * 100)}% confidence
              </p>
            </div>
            {/* Reject is exactly as reachable as Accept: same row, same size, same enabled state. */}
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!!disabledReason}
                aria-label={`Accept correction: ${proposal.original} to ${proposal.proposed}`}
                onClick={() => accept(proposal)}
              >
                <IconCheck aria-hidden />
                Accept
              </Button>
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
