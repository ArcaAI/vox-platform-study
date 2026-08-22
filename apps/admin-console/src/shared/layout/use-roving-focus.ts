'use client';

import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * Roving tabindex for a composite navigation widget (TASK-788 AC-8).
 *
 * The rail and the scoped sidebar are each ONE tab stop: exactly one item
 * carries `tabIndex=0` (the active one, else the first), every sibling carries
 * `tabIndex=-1`, and the arrow keys move focus between them. Tab therefore
 * steps *past* the whole nav instead of through 56 links, and focus is never
 * trapped — nothing here captures Tab, Escape or Shift+Tab.
 *
 * Note the deliberate contrast with the reference system's EX-11 defect: a
 * `tabIndex=-1` item here is still a real, clickable link, just not a tab stop.
 * We never render an item that looks interactive but cannot be used.
 */
export type RovingOrientation = 'vertical' | 'horizontal';

/** Marks a focusable item inside the container the hook manages. */
export const ROVING_ITEM_ATTRIBUTE = 'data-roving-item';

const NEXT_KEY: Record<RovingOrientation, string> = { vertical: 'ArrowDown', horizontal: 'ArrowRight' };
const PREVIOUS_KEY: Record<RovingOrientation, string> = { vertical: 'ArrowUp', horizontal: 'ArrowLeft' };

export function useRovingFocus<T extends HTMLElement>(orientation: RovingOrientation = 'vertical') {
  const containerRef = useRef<T>(null);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      const container = containerRef.current;
      if (!container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(`[${ROVING_ITEM_ATTRIBUTE}]`));
      if (items.length === 0) return;

      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (event.key === NEXT_KEY[orientation]) {
        next = current < 0 ? 0 : (current + 1) % items.length;
      } else if (event.key === PREVIOUS_KEY[orientation]) {
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = items.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      items[next]?.focus();
    },
    [orientation],
  );

  return { containerRef, onKeyDown };
}

/** Props every roving item needs: the marker attribute plus its tab-stop state. */
export function rovingItemProps(isTabStop: boolean) {
  return { [ROVING_ITEM_ATTRIBUTE]: '', tabIndex: isTabStop ? 0 : -1 } as const;
}
