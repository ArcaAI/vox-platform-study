/**
 * The console-wide dialog width scale (TASK-983 R11, owner decision OD-7).
 *
 * Rule 11 §3 "Responsive Sizing" already named three sizes; before this map
 * each dialog spelled its own width inline, so the console carried ~50 call
 * sites across ten distinct widths (`sm:max-w-lg`, `36rem`, `40rem`, `42rem`,
 * `46rem`, `640px`, `50vw`, …) and no way to re-tune them together. The map is
 * the single place a bucket changes; a call site passes a bucket, never a
 * width.
 *
 * | Bucket | Use | Width |
 * |---|---|---|
 * | `sm` | confirmations, single-question dialogs | `sm:max-w-md` (448px) |
 * | `md` | multi-field forms | 50vw |
 * | `lg` | editors, multi-tab and list-bearing dialogs | 70vw at a fixed 70vh |
 *
 * `lg` carries the SHAPE as well as the width: the fixed height plus the flex
 * column that lets the body own `min-h-0 flex-1 overflow-y-auto` while the
 * header and footer stay put (rule 11 §1 "Forms Inside Dialogs"). `sm` and
 * `md` stay height-free so short content keeps its natural height.
 */
export type DialogSize = 'sm' | 'md' | 'lg';

export const DIALOG_SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-[50vw]',
  lg: 'flex h-[70vh] flex-col sm:max-w-[70vw]',
};
