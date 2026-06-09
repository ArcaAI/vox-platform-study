import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import type { SoapSectionGroup } from '@arcaai/vox';
import { FileText } from 'lucide-react';
import { ClaimLine } from './claim-line';

interface SoapNotePanelProps {
  /** Claims grouped into the four SOAP sections (in order), from the caller. */
  sections: SoapSectionGroup[];
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
}

/**
 * The drafted note, grouped by SOAP section. Each claim line is selectable to
 * drive the side-by-side transcript highlight.
 */
export function SoapNotePanel({ sections, selectedClaimId, onSelect }: SoapNotePanelProps) {
  const totalClaims = sections.reduce((sum, group) => sum + group.claims.length, 0);
  return (
    <Card data-testid="soap-note">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="size-4 text-blue-500" />
            Draft note (SOAP)
          </CardTitle>
          <Badge variant="secondary" className="tabular-nums text-[10px]">
            {totalClaims} {totalClaims === 1 ? 'claim' : 'claims'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sections.map((group) => (
          <section key={group.section} data-section={group.section} className="flex flex-col gap-2">
            <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
              <span className="bg-muted text-foreground inline-flex size-5 items-center justify-center rounded font-mono">{group.section}</span>
              {group.label}
            </h3>
            {group.claims.length === 0 ? (
              <p className="text-muted-foreground border-l-2 pl-3 text-xs italic">No claims drafted for this section.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {group.claims.map((claim) => (
                  <ClaimLine key={claim.id} claim={claim} active={claim.id === selectedClaimId} onSelect={onSelect} />
                ))}
              </div>
            )}
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
