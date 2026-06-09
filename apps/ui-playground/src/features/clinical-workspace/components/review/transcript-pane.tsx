import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import type { CitationClaim, HighlightSegment } from '@arcaai/vox';
import { AlertTriangle, FileText } from 'lucide-react';

export interface TranscriptHighlightPane {
  contextItemId: string;
  label?: string;
  segments: HighlightSegment[];
  /** True when the selected claim cites this transcript. */
  hasHighlight: boolean;
}

interface TranscriptPaneProps {
  panes: TranscriptHighlightPane[];
  /** The currently selected claim (drives the highlight + notices), or null. */
  selectedClaim: CitationClaim | null;
}

function renderSegments(segments: HighlightSegment[]) {
  return segments.map((segment, index) =>
    segment.highlighted ? (
      <mark key={index} data-highlight="true" className="rounded-sm bg-amber-200/80 px-0.5 text-amber-950 dark:bg-amber-400/30 dark:text-amber-50">
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}

/**
 * Side-by-side transcript view. When a claim is selected, the evidence spans it
 * cites (resolved by char-offset upstream) are highlighted in the source
 * transcript; claims without provenance surface an explicit warning instead.
 */
export function TranscriptPane({ panes, selectedClaim }: TranscriptPaneProps) {
  const hasSelection = !!selectedClaim;
  const selectedHasEvidence = hasSelection && selectedClaim.evidence.length > 0;

  return (
    <Card data-testid="transcript-pane">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="size-4 text-violet-500" />
          Transcript evidence
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {hasSelection
            ? selectedHasEvidence
              ? 'Highlighted spans are the evidence for the selected claim.'
              : 'The selected claim has no linked transcript evidence.'
            : 'Select a claim to highlight the transcript spans it was grounded in.'}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hasSelection && !selectedHasEvidence && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-50/60 p-2.5 dark:bg-amber-950/20">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              This claim is <strong>{selectedClaim.status}</strong> with no provenance. Confirm it against the record before signing.
            </p>
          </div>
        )}

        {panes.map((pane) => (
          <div key={pane.contextItemId} className="flex flex-col gap-1.5">
            {pane.label && (
              <span className="text-muted-foreground font-mono text-[10px]">
                {pane.label} · {pane.contextItemId}
              </span>
            )}
            <ScrollArea className="h-[28rem] rounded-md border">
              <p className={cn('p-3 text-sm leading-relaxed whitespace-pre-wrap', hasSelection && !pane.hasHighlight && 'text-muted-foreground')}>
                {renderSegments(pane.segments)}
              </p>
            </ScrollArea>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
