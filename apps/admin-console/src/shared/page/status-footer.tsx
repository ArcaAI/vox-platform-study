import type { ReactNode } from 'react';
import { cn } from '@arcaai/ui';

/**
 * StatusFooter — the console's IDE-style footer status bar (Figma "09 - Screen
 * Templates" §3; rule 11 §Screen Template). It rides in the `footer` slot of
 * `ScreenTemplate`, pinned at the bottom of the page (below the data grid's
 * pagination). `start` carries the primary status/message (a polite live region
 * so async updates are announced); `end` carries secondary meta (counts,
 * last-updated, endpoint hints).
 *
 * Nested inside the shell's `<main>` (SidebarInset), so `<footer>` is a
 * sectioning footer — not a duplicate `contentinfo` landmark.
 */
export function StatusFooter({ start, end, className }: { start?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <footer
      aria-label="Page status"
      className={cn('bg-card text-muted-foreground flex h-8 items-center gap-3 rounded-md border px-3 text-xs', className)}
    >
      <div aria-live="polite" className="flex min-w-0 flex-1 items-center gap-3 truncate">
        {start}
      </div>
      {end ? <div className="flex shrink-0 items-center gap-3">{end}</div> : null}
    </footer>
  );
}
