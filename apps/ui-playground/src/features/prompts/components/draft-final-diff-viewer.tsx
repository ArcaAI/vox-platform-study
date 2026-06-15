import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { GitCompare } from 'lucide-react';

import { VersionDiffPanel } from '@/components/version-diff-panel';

export interface DraftFinalDiffViewerProps {
  /** Left/baseline text (the "draft" or the default being compared against). */
  draftText: string;
  /** Right/edited text (the "final" or the caller's personal version). */
  finalText: string;
  draftLabel?: string;
  finalLabel?: string;
  draftDate?: string | null;
  finalDate?: string | null;
  title?: string;
  description?: string;
  emptyHint?: string;
}

/**
 * TASK-356 Phase 6 (S7) — read-only draft↔final diff viewer.
 *
 * A thin, presentational wrapper over the shared `VersionDiffPanel` that frames a
 * two-sided comparison as "draft → final" (left = draft/baseline, right =
 * final/edited). Surfaced on the doctor "My Prompts" page to show how a personal
 * prompt diverges from its category default; deliberately generic so it can also
 * render an AI-draft ↔ signed-summary pair (the edit-capture story) without
 * change. Read-only — it never mutates.
 */
export function DraftFinalDiffViewer({
  draftText,
  finalText,
  draftLabel = 'AI Draft',
  finalLabel = 'Final',
  draftDate,
  finalDate,
  title = 'Draft → Final',
  description = 'Read-only comparison of the draft and the final, edited version.',
  emptyHint = 'No content to compare yet.',
}: DraftFinalDiffViewerProps) {
  const hasContent = (draftText?.trim().length ?? 0) > 0 || (finalText?.trim().length ?? 0) > 0;

  return (
    <Card data-doc="draft-final-diff">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="size-4" aria-hidden="true" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {hasContent ? (
          <VersionDiffPanel
            left={{ versionNumber: 1, date: draftDate ?? null, changeReason: draftLabel }}
            right={{ versionNumber: 2, date: finalDate ?? null, changeReason: finalLabel }}
            sections={[{ label: 'Content', oldText: draftText ?? '', newText: finalText ?? '' }]}
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <GitCompare className="text-muted-foreground/50 mb-2 size-7" aria-hidden="true" />
            <p className="text-muted-foreground text-sm">{emptyHint}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
