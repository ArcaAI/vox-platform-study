/**
 * The dialog width scale (TASK-983 R11 / OD-7). One map, three buckets — the
 * console-wide sizes rule 11 §3 "Responsive Sizing" names. Pinned here so a
 * bucket can be re-tuned in ONE place and every migrated call site moves with
 * it; a call site that hand-rolls a width is the drift this map exists to stop.
 */

import { describe, expect, it } from 'vitest';
import { DIALOG_SIZE_CLASS } from '../dialog-size';

describe('DIALOG_SIZE_CLASS', () => {
  it('pins the three buckets of rule 11 §3', () => {
    expect(DIALOG_SIZE_CLASS).toEqual({
      sm: 'sm:max-w-md',
      md: 'sm:max-w-[50vw]',
      lg: 'flex h-[70vh] flex-col sm:max-w-[70vw]',
    });
  });

  /**
   * The large bucket carries the SHAPE as well as the width: a fixed height plus
   * the flex column that lets the body own `min-h-0 flex-1 overflow-y-auto`
   * while the header and footer stay put (rule 11 §1 "Dialogs & Modals").
   */
  it('makes the large bucket a fixed-height flex column, not just a width', () => {
    expect(DIALOG_SIZE_CLASS.lg).toContain('flex');
    expect(DIALOG_SIZE_CLASS.lg).toContain('flex-col');
    expect(DIALOG_SIZE_CLASS.lg).toContain('h-[70vh]');
  });

  it('keeps the small (confirmation) bucket narrow and height-free', () => {
    expect(DIALOG_SIZE_CLASS.sm).not.toContain('h-');
    expect(DIALOG_SIZE_CLASS.sm).not.toContain('vw');
  });
});
