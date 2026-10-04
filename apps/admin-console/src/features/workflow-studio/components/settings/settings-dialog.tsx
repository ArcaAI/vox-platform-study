'use client';

/**
 * Workflow settings dialog (TASK-1036 §3.5): connections, sources, context schema (Input / Output
 * shape) with live implications. Placeholder: the studio header (lane C2a) opens it; lane C2b (owner
 * of the graph store) fills it and writes `graph.settings`. Keep the props contract stable.
 */
export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly?: boolean;
}

export function SettingsDialog(_props: SettingsDialogProps) {
  return null;
}
