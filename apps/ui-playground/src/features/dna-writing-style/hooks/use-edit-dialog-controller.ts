import { useCallback, useState } from 'react';

import type { DnaReport } from '../api/dna-writing-styles';

export interface EditDialogController {
  open: boolean;
  report: DnaReport | null;
  /** Open the edit dialog seeded with a specific report (the Edit trigger). */
  openFor: (report: DnaReport) => void;
  /** Close the dialog and clear the selection. */
  close: () => void;
  setOpen: (open: boolean) => void;
}

/**
 * Owns the DNA edit-dialog open/selection state.
 *
 * TASK-329 P5 (bug fix) — the previous page kept `editOpen`/`selectedReport`
 * as separate `useState`s but never wired a trigger that set BOTH, so the
 * dialog could only ever open with a null report (empty form). `openFor`
 * couples "select this report" and "open" into a single intent so the dialog
 * is always seeded before it is shown.
 */
export function useEditDialogController(): EditDialogController {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DnaReport | null>(null);

  const openFor = useCallback((next: DnaReport) => {
    setReport(next);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setReport(null);
  }, []);

  return { open, report, openFor, close, setOpen };
}
