'use client';

import { IconCheck, IconMinus, IconX } from '@tabler/icons-react';
import { cx } from '@/shared/cx';
import { PLATFORM_COLUMN } from '../api/types';

/** The three states a matrix cell can hold. `null` = inherit. */
export type CellValue = boolean | null;

/**
 * Inherit -> on -> off -> inherit.
 *
 * Inherit is FIRST in the cycle rather than a state you can only reach from a
 * menu: "stop having an opinion about this" is the most common correction on a
 * matrix like this, and burying it costs an extra interaction every time.
 */
export function nextCellValue(current: CellValue): CellValue {
  if (current === null) return true;
  if (current === true) return false;
  return null;
}

export interface TriStateCellProps {
  value: CellValue;
  /** What the cell resolves to when `value` is null — rendered ghosted. */
  inheritedValue: boolean;
  /** Accessible name. Must name BOTH the feature and the column. */
  label: string;
  disabled?: boolean;
  /** Why it is disabled, for the title/description. */
  disabledReason?: string;
  onChange: (next: CellValue) => void;
  /** Marks an edit that has not been saved yet. */
  dirty?: boolean;
}

/**
 * One tri-state matrix cell.
 *
 * -- WHY A BUTTON WITH role="checkbox" AND NOT A CHECKBOX PRIMITIVE ----------
 * The third state is the point. A real `<input type="checkbox">` has two
 * states plus a VISUAL `indeterminate` flag that is not a value, and Radix's
 * checkbox exposes `indeterminate` but cycles binary. Here "inherits the
 * platform default" is a genuine third value the admin sets and unsets, so the
 * control is a real `<button>` carrying `role="checkbox"` and
 * `aria-checked="mixed"` -- which is exactly what ARIA defines mixed for. A
 * button gets Space and Enter activation from the platform, so the keyboard
 * cycle needs no key handler of its own (rule 11 sect.7: real buttons, never
 * clickable divs).
 *
 * -- WHY THE INHERITED VALUE IS DRAWN, NOT LEFT BLANK -----------------------
 * An empty cell answers "is this feature on for this tenant?" with silence. The
 * inherited value is drawn ghosted so the row reads as a row: what every tenant
 * currently resolves to, with the overridden ones standing out.
 */
export function TriStateCell({ value, inheritedValue, label, disabled, disabledReason, onChange, dirty }: TriStateCellProps) {
  const effective = value ?? inheritedValue;
  const inherits = value === null;
  const ariaChecked = inherits ? 'mixed' : value === true;

  const stateWord = inherits ? `inherits ${inheritedValue ? 'on' : 'off'}` : value ? 'on' : 'off';

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked}
      aria-label={`${label} — ${stateWord}`}
      // Never colour alone (rule 11 sect.10): the glyph differs per state and the
      // accessible name says it in words.
      title={disabled ? disabledReason : `${label} — ${stateWord}`}
      disabled={disabled}
      onClick={() => onChange(nextCellValue(value))}
      className={cx(
        'focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none',
        disabled && 'cursor-not-allowed opacity-40',
        !disabled && 'hover:bg-accent cursor-pointer',
        // Emphasis comes from the BORDER and the glyph, never from the primary
        // ink token: under the achromatic palette it resolves to body ink and
        // would render nothing at all (`emphasis-canon.test.ts` guards it).
        inherits ? 'text-muted-foreground border-dashed' : effective ? 'border-primary text-foreground' : 'text-muted-foreground',
        dirty && 'border-warning ring-warning/40 ring-2 ring-offset-1',
      )}
    >
      {inherits ? (
        // Mixed: the inherited answer, ghosted, plus the dash that says "not
        // set here". Two marks, because one of them has to survive greyscale.
        <span aria-hidden className="flex items-center">
          <IconMinus className="size-3.5" />
        </span>
      ) : effective ? (
        <IconCheck aria-hidden className="size-4" />
      ) : (
        <IconX aria-hidden className="size-4" />
      )}
    </button>
  );
}

/** Column header text for a cell's tenant, so labels read the same everywhere. */
export function columnLabel(tenantId: string, tenantName?: string): string {
  return tenantId === PLATFORM_COLUMN ? 'Platform default' : (tenantName ?? tenantId);
}
