'use client';

import * as React from 'react';

import { resolveContainerBreakpoint, type ContainerBreakpoint } from './pagination-window';

/**
 * Measure an element's own width and map it to a breakpoint at
 * the viewport thresholds (640/768/1024/1280). Container-first: the grid
 * degrades to its own width, correct whether the sidebar is open or collapsed.
 * Defaults to `xl` before the first measurement (desktop-first, no mobile flash
 * on SSR / first paint).
 */
export function useContainerBreakpoint(ref: React.RefObject<HTMLElement | null>): { width: number | null; bp: ContainerBreakpoint } {
  const [width, setWidth] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width || el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return { width, bp: width == null ? 'xl' : resolveContainerBreakpoint(width) };
}

/**
 * True on coarse pointers (touch). Comfortable density + ≥44px hit areas are
 * enforced there. Guarded for non-DOM/test environments.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return coarse;
}
