/**
 * Pure pagination math. Kept framework-free so the numbered
 * window, item-range status, and responsive radius are unit-testable without
 * rendering.
 */

export type PageItem = number | 'ellipsis-left' | 'ellipsis-right';

/** Container breakpoints keyed to the viewport numbers the brief names. */
export type ContainerBreakpoint = 'base' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Numbered window: always page 1 + page N, the clamped `current ± radius`
 * neighbourhood, ellipses for real gaps, and a single omitted page rendered
 * verbatim instead of a one-page `…`. Returns `[]` when `radius <= 0` or there
 * is a single page (the caller renders `Prev/Next` + "Page p of N").
 */
export function getPaginationRange({ page, pageCount, radius }: { page: number; pageCount: number; radius: number }): PageItem[] {
  const total = Math.max(1, pageCount);
  const current = page + 1; // 1-based
  if (radius <= 0 || total <= 1) return [];

  const windowStart = Math.max(1, current - radius);
  const windowEnd = Math.min(total, current + radius);

  const pages = new Set<number>([1, total]);
  for (let i = windowStart; i <= windowEnd; i++) pages.add(i);

  const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);

  const items: PageItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      const gap = cur - prev;
      if (gap === 2) {
        items.push(prev + 1); // single hidden page → render it, not an ellipsis
      } else if (gap > 2) {
        items.push(prev < current ? 'ellipsis-left' : 'ellipsis-right');
      }
    }
    items.push(cur);
  }
  return items;
}

/** Item-range for the status line: `Showing {first}–{last} of {total}`. */
export function getItemRange({ page, limit, total }: { page: number; limit: number; total: number }): { first: number; last: number; total: number } {
  if (total <= 0) return { first: 0, last: 0, total: 0 };
  const first = page * limit + 1;
  const last = Math.min((page + 1) * limit, total);
  return { first, last, total };
}

/** Map a container width (px) to a breakpoint at the viewport thresholds. */
export function resolveContainerBreakpoint(width: number): ContainerBreakpoint {
  if (width >= 1280) return 'xl';
  if (width >= 1024) return 'lg';
  if (width >= 768) return 'md';
  if (width >= 640) return 'sm';
  return 'base';
}

/** Numbered-window radius per breakpoint (drops from the ends inward, §B2). */
export function getPagerRadius(bp: ContainerBreakpoint): number {
  switch (bp) {
    case 'xl':
    case 'lg':
      return 2;
    case 'md':
      return 1;
    default:
      return 0;
  }
}
