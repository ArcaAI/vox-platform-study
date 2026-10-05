'use client';

/**
 * Version history for one workflow lineage (TASK-1036 §3.3, §3.6). The studio header opens it; it
 * renders the same `LineageVersionsPanel` the list screen's row drawer does, keyed by slug.
 */
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useWorkflowLineageBySlug } from '../../api';
import { LineageVersionsPanel } from './lineage-versions-panel';

export interface VersionHistorySheetProps {
  slug: string;
  currentDefinitionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VersionHistorySheet({ slug, currentDefinitionId, open, onOpenChange }: VersionHistorySheetProps) {
  // Only fetched while open: the studio header mounts this for every workflow it shows.
  const lineage = useWorkflowLineageBySlug(slug, open);
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={lineage.data?.name ?? slug}
      meta={<span className="font-mono text-xs">{slug}</span>}
      size="lg"
    >
      {open ? <LineageVersionsPanel slug={slug} lineage={lineage.data ?? undefined} anchorId={currentDefinitionId} onNavigate={() => onOpenChange(false)} /> : null}
    </DetailDrawer>
  );
}
