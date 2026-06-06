import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import type { CitationClaim } from '@arcaai/vox';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { ClaimLine } from './claim-line';

interface NeedsAttentionListProps {
  /** Flagged + unverified claims, already floated to the top by the caller. */
  claims: CitationClaim[];
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
}

/**
 * The core anti-omission surface: every claim a sensor could not verify
 * (flagged first, then unverified) floated above the note so the clinician
 * cannot miss them.
 */
export function NeedsAttentionList({ claims, selectedClaimId, onSelect }: NeedsAttentionListProps) {
  return (
    <Card data-testid="needs-attention" className="border-amber-300/60 dark:border-amber-800/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListChecks className="size-4 text-amber-600 dark:text-amber-400" />
            Needs attention
          </CardTitle>
          <Badge variant="outline" className="tabular-nums text-[10px]">
            {claims.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {claims.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            <p className="text-muted-foreground text-xs">Every claim is grounded in the transcript. Nothing flagged for review.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {claims.map((claim) => (
              <ClaimLine key={claim.id} claim={claim} active={claim.id === selectedClaimId} onSelect={onSelect} showSection />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
