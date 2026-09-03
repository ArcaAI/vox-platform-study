import type { ReactNode } from 'react';
import { cn } from '@arcaai/ui';

/**
 * ScreenTemplate — the standardized console page frame (Figma "09 - Screen
 * Templates"; rules 11 Template + 12). It fills the shell's content
 * region as a fixed-height flex column so ONLY the content scrolls: the top
 * group is pinned above and the footer status bar is pinned below.
 *
 * Region contract (top → bottom):
 *   Pinned top, in priority order — `header` → `stats` → `statusBanner`
 *     → `toolbar` → `tabs`.
 *   Full-width content — `children` (main content / charts / tab panels / data
 *     grid). A fill-height `AdminDataGrid` keeps its own sticky header, scrolling
 *     body and bottom pagination, which lands directly above the footer.
 *   Pinned bottom — `footer` (a `StatusFooter`).
 *
 * Because the frame is a fixed-height flex column (not `position: sticky`), the
 * pinned regions never overlap content and never obscure focus (WCAG 2.4.11) —
 * no z-index, backdrop or `scroll-mt` needed.
 *
 * Content modes:
 *   • `scroll` (default) — the content region scrolls (dashboards, detail pages,
 *     forms, tab panels).
 *   • `fill` — the single child owns the remaining height and its own scroll
 *     (a fill-height `AdminDataGrid`). Never nest another scroll area inside.
 *
 * Tabs: wrap the whole template in `<Tabs>` and pass `<TabsList>` to `tabs` and
 * the `<TabsContent>` panels as `children` — both share the Tabs context even
 * though they render in different regions.
 */
export interface ScreenTemplateProps {
  /** Pinned top, 1st: page header (title + actions). Breadcrumbs stay in the shell topbar. */
  header: ReactNode;
  /** Pinned top, 2nd: stat cards / badges strip. */
  stats?: ReactNode;
  /** Pinned top, 3rd: page-level status/alert banner (stale-data `ErrorBanner`, "Acting on: …", etc.). */
  statusBanner?: ReactNode;
  /** Pinned top, 4th: toolbar (search + filters + actions). Grid pages carry their toolbar INSIDE the grid. */
  toolbar?: ReactNode;
  /** Pinned top, 5th: tab list (render inside a wrapping `<Tabs>`; the panels go in `children`). */
  tabs?: ReactNode;
  /** Full-width content: main content / charts / tab panels / data grid. */
  children: ReactNode;
  /** `scroll` (default) scrolls the content; `fill` hands the height to a fill-height child (data grid). */
  contentMode?: 'scroll' | 'fill';
  /** Pinned bottom: IDE-style footer status bar (`StatusFooter`). */
  footer?: ReactNode;
  className?: string;
}

export function ScreenTemplate({
  header,
  stats,
  statusBanner,
  toolbar,
  tabs,
  children,
  contentMode = 'scroll',
  footer,
  className,
}: ScreenTemplateProps) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex shrink-0 flex-col gap-4">
        {header}
        {stats}
        {statusBanner}
        {toolbar}
        {tabs}
      </div>
      <div className={cn('mt-4', contentMode === 'fill' ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-y-auto')}>{children}</div>
      {footer ? <div className="mt-4 shrink-0">{footer}</div> : null}
    </div>
  );
}
