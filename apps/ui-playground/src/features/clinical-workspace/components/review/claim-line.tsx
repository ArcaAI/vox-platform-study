import { cn } from '@/lib/utils';
import type { CitationClaim } from '@arcaai/vox';
import { SOAP_SECTION_LABELS } from '@arcaai/vox';
import { ClaimStatusBadge } from './claim-status-badge';
import { ConfidenceIndicator } from './confidence-indicator';

interface ClaimLineProps {
  claim: CitationClaim;
  active: boolean;
  onSelect: (claimId: string) => void;
  /** Show the SOAP section tag (used in the cross-section "needs attention" list). */
  showSection?: boolean;
}

/**
 * One clickable "note line" — selecting it drives the transcript highlight.
 * Rendered both inside the SOAP note (per section) and the needs-attention list.
 */
export function ClaimLine({ claim, active, onSelect, showSection = false }: ClaimLineProps) {
  const evidenceCount = claim.evidence.length;
  return (
    <button
      type="button"
      data-claim-id={claim.id}
      data-active={active}
      aria-pressed={active}
      onClick={() => onSelect(claim.id)}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors',
        'hover:bg-muted/60 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        active ? 'border-primary bg-primary/5 ring-primary/30 ring-1' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <ClaimStatusBadge status={claim.status} />
        {showSection && (
          <span className="text-muted-foreground rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">{SOAP_SECTION_LABELS[claim.section]}</span>
        )}
        <ConfidenceIndicator confidence={claim.confidence} className="ml-auto" />
      </div>
      <p className="text-sm leading-snug">{claim.text}</p>
      <div className="text-muted-foreground flex items-center gap-3 text-[10px]">
        {evidenceCount > 0 ? (
          <span>
            {evidenceCount} linked {evidenceCount === 1 ? 'source' : 'sources'}
          </span>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">No linked transcript evidence</span>
        )}
        {claim.entityRefs.length > 0 && (
          <span>
            {claim.entityRefs.length} {claim.entityRefs.length === 1 ? 'entity' : 'entities'}
          </span>
        )}
      </div>
    </button>
  );
}
