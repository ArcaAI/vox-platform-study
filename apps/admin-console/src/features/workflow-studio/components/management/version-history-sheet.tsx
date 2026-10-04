'use client';

/**
 * Version history for one workflow lineage (TASK-1036 §3.3, §3.6). Placeholder: the studio header
 * (lane C2a) opens it; lane C1 fills it (VersionHistoryPanel rows with open / publish / activate /
 * deprecate / delete). Keep the props contract stable.
 */
export interface VersionHistorySheetProps {
  slug: string;
  currentDefinitionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VersionHistorySheet(_props: VersionHistorySheetProps) {
  return null;
}
